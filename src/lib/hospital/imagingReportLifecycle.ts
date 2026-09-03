import { Prisma } from "@prisma/client";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";

type Tx = Prisma.TransactionClient;

export class ReportConcurrencyError extends BadRequestError {
  constructor(action: string) {
    super(`Report was already ${action} by someone else, or is no longer in the expected state. Refresh and try again.`);
  }
}

export class ReportNotAmendableError extends BadRequestError {
  constructor() {
    super("Only a currently-verified report can be amended.");
  }
}

/**
 * Milestone E hardening — a DB-level partial unique index
 * (`ImagingReport_current_per_order`, see prisma/migrations) now backstops
 * the "at most one isCurrent report per order" invariant. Two concurrent
 * enterReport calls can no longer both create a current row; the loser
 * hits this P2002 and gets a clean rejection instead of a raw 500.
 */
function isDuplicateCurrentReportError(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "P2002");
}

export interface EnterReportInput {
  imagingOrderId: string;
  studyId?: string | null;
  indication?: string | null;
  technique?: string | null;
  findings: string;
  impression: string;
  recommendations?: string | null;
  isCritical: boolean;
  reportedByStaffId: string;
}

/**
 * Report entry (brief §11-12). Conceptually mirrors labResultLifecycle's
 * enterResult/verifyResult/amendResult shape (fresh row per version,
 * never edit-in-place) but is its own implementation against
 * ImagingReport — not a reuse of LabResult (brief explicitly: "do not
 * force radiology into LabResult semantics").
 */
export async function enterReport(tx: Tx, input: EnterReportInput) {
  let report;
  try {
    report = await tx.imagingReport.create({
      data: {
        imagingOrderId: input.imagingOrderId,
        studyId: input.studyId ?? undefined,
        indication: input.indication ?? undefined,
        technique: input.technique ?? undefined,
        findings: input.findings,
        impression: input.impression,
        recommendations: input.recommendations ?? undefined,
        isCritical: input.isCritical,
        reportedByStaffId: input.reportedByStaffId,
        status: "ENTERED",
      },
    });
  } catch (err) {
    if (isDuplicateCurrentReportError(err)) throw new ReportConcurrencyError("entered");
    throw err;
  }

  await tx.imagingOrder.updateMany({ where: { id: input.imagingOrderId, status: "ACQUIRED" }, data: { status: "REPORTED" } });
  return report;
}

/** Guarded — ENTERED -> VERIFIED once; concurrent double-verify is rejected, not silently accepted twice (brief §23 test #3). */
export async function verifyReport(tx: Tx, reportId: string, verifiedByStaffId: string) {
  const result = await tx.imagingReport.updateMany({
    where: { id: reportId, status: "ENTERED", isCurrent: true },
    data: { status: "VERIFIED", verifiedByStaffId, verifiedAt: new Date() },
  });
  if (result.count !== 1) throw new ReportConcurrencyError("verified");
  return tx.imagingReport.findUniqueOrThrow({ where: { id: reportId } });
}

/**
 * Critical-finding acknowledgement (brief §13) — deliberately separate
 * from verify (see schema comment on ImagingReport). Guarded on
 * acknowledgedAt being null so two clinicians acknowledging simultaneously
 * don't both "win" silently — a stricter guard than Lab's Milestone B
 * acknowledge route used, applying the same concurrency idiom already
 * established elsewhere in this codebase to a spot Milestone B left
 * unguarded.
 */
export async function acknowledgeReport(tx: Tx, reportId: string, acknowledgedByStaffId: string) {
  const result = await tx.imagingReport.updateMany({
    where: { id: reportId, isCritical: true, acknowledgedAt: null },
    data: { acknowledgedByStaffId, acknowledgedAt: new Date() },
  });
  if (result.count !== 1) throw new ReportConcurrencyError("acknowledged");
  return tx.imagingReport.findUniqueOrThrow({ where: { id: reportId } });
}

/** Amendment (brief §11) — the previous verified version is preserved unchanged, never overwritten. */
export async function amendReport(
  tx: Tx,
  reportId: string,
  input: { findings: string; impression: string; recommendations?: string | null; isCritical?: boolean; reason: string; amendedByStaffId: string }
) {
  const original = await tx.imagingReport.findUnique({ where: { id: reportId } });
  if (!original) throw new NotFoundError("Report not found.");
  if (original.status !== "VERIFIED" || !original.isCurrent) throw new ReportNotAmendableError();

  const supersede = await tx.imagingReport.updateMany({
    where: { id: reportId, status: "VERIFIED", isCurrent: true },
    data: { isCurrent: false, status: "SUPERSEDED" },
  });
  if (supersede.count !== 1) throw new ReportConcurrencyError("amended");

  let amended;
  try {
    amended = await tx.imagingReport.create({
      data: {
        studyId: original.studyId,
        imagingOrderId: original.imagingOrderId,
        indication: original.indication,
        technique: original.technique,
        findings: input.findings,
        impression: input.impression,
        recommendations: input.recommendations ?? original.recommendations,
        isCritical: input.isCritical ?? original.isCritical,
        reportedByStaffId: original.reportedByStaffId,
        status: "AMENDED",
        version: original.version + 1,
        isCurrent: true,
        previousVersionId: original.id,
        amendedReason: input.reason,
        amendedByStaffId: input.amendedByStaffId,
        amendedAt: new Date(),
      },
    });
  } catch (err) {
    if (isDuplicateCurrentReportError(err)) throw new ReportConcurrencyError("amended");
    throw err;
  }

  return { original, amended };
}
