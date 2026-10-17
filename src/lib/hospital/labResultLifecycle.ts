import { Prisma, LabResultType } from "@prisma/client";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";
import { findApplicableReferenceRange, computeAbnormalFlag } from "./labCatalog";
import { syncOrderStatus } from "./orderEnvelope";

type Tx = Prisma.TransactionClient;

/** The order's patient, encounter and facility: the tenant and correlation of a result's events. */
function resultContext(tx: Tx, labOrderId: string) {
  return tx.labOrder.findUniqueOrThrow({ where: { id: labOrderId }, select: { patientId: true, encounterId: true, encounter: { select: { facilityId: true } } } });
}

/** Whole minutes from release (verification, else entry) to acknowledgement. */
export function minutesBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 60_000));
}

export class ResultConcurrencyError extends BadRequestError {
  constructor(action: string) {
    super(`Result was already ${action} by someone else, or is no longer in the expected state. Refresh and try again.`);
  }
}

/**
 * Milestone E hardening — a DB-level partial unique index
 * (`LabResult_current_per_order_test`, see prisma/migrations) now backstops
 * the "at most one isCurrent result per order+test" invariant. Two
 * concurrent enterResult calls can no longer both create a current row; the
 * loser hits this P2002 and gets a clean rejection instead of a raw 500.
 */
function isDuplicateCurrentResultError(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "P2002");
}

export class ResultNotAmendableError extends BadRequestError {
  constructor() {
    super("Only a currently-verified result can be amended.");
  }
}

export interface EnterResultInput {
  labOrderId: string;
  specimenId?: string | null;
  catalogTestId?: string | null;
  resultType?: LabResultType | null;
  value: string;
  unit?: string | null;
  numericValue?: number | null;
  referenceRange?: string | null;
  isCritical: boolean;
  releasedByStaffId?: string | null;
  patientSex?: string | null;
  patientAgeYears?: number | null;
}

/**
 * Result entry (brief §17). Computes an abnormal flag ONLY when a
 * catalogTestId + numeric value + a configured LabReferenceRange all
 * exist — never a guessed/invented range. Advances the parent LabOrder to
 * RESULTED once every panel member (or the single test, for a non-panel
 * order) has a current result.
 */
export async function enterResult(tx: Tx, input: EnterResultInput) {
  let abnormalFlag = null;
  if (input.catalogTestId && input.numericValue != null) {
    const range = await findApplicableReferenceRange(input.catalogTestId, input.patientSex, input.patientAgeYears);
    abnormalFlag = computeAbnormalFlag(input.numericValue, range);
  }

  let result;
  try {
    result = await tx.labResult.create({
      data: {
        labOrderId: input.labOrderId,
        specimenId: input.specimenId ?? undefined,
        catalogTestId: input.catalogTestId ?? undefined,
        resultType: input.resultType ?? undefined,
        value: input.value,
        unit: input.unit ?? undefined,
        numericValue: input.numericValue ?? undefined,
        referenceRange: input.referenceRange ?? undefined,
        abnormalFlag: abnormalFlag ?? undefined,
        isCritical: input.isCritical,
        releasedByStaffId: input.releasedByStaffId ?? undefined,
        status: "ENTERED",
      },
    });
  } catch (err) {
    if (isDuplicateCurrentResultError(err)) throw new ResultConcurrencyError("entered");
    throw err;
  }

  if (input.specimenId) {
    await tx.specimen.updateMany({ where: { id: input.specimenId, status: "ACCEPTED" }, data: { status: "RESULTED" } });
  }

  const order = await tx.labOrder.findUniqueOrThrow({ where: { id: input.labOrderId } });
  if (order.panelId) {
    const [memberCount, currentResultCount] = await Promise.all([
      tx.labPanelTest.count({ where: { panelId: order.panelId } }),
      tx.labResult.count({ where: { labOrderId: input.labOrderId, isCurrent: true } }),
    ]);
    if (currentResultCount >= memberCount) {
      await tx.labOrder.updateMany({ where: { id: input.labOrderId, status: "IN_PROGRESS" }, data: { status: "RESULTED" } });
    await syncOrderStatus(tx, "LAB", input.labOrderId);
    }
  } else {
    await tx.labOrder.updateMany({ where: { id: input.labOrderId, status: "IN_PROGRESS" }, data: { status: "RESULTED" } });
    await syncOrderStatus(tx, "LAB", input.labOrderId);
  }

  return result;
}

/**
 * Critical-result acknowledgement — Milestone E hardening. Previously the
 * route did an unscoped `results[0]` pick (arbitrary for panel orders with
 * multiple legitimately-current results) and an unguarded update with no
 * `isCritical` check, so it could silently "critically acknowledge" a
 * non-critical result, or let two simultaneous acks both succeed under two
 * different staff IDs with no conflict signal. Mirrors
 * imagingReportLifecycle.ts's acknowledgeReport, which already used this
 * guarded idiom.
 */
export async function acknowledgeResult(tx: Tx, resultId: string, acknowledgedByStaffId: string, byUserId?: string) {
  const result = await tx.labResult.updateMany({
    where: { id: resultId, isCritical: true, acknowledgedAt: null },
    data: { acknowledgedByStaffId, acknowledgedAt: new Date() },
  });
  if (result.count !== 1) throw new ResultConcurrencyError("acknowledged");
  const acked = await tx.labResult.findUniqueOrThrow({ where: { id: resultId } });
  // CriticalResultAcknowledged (spine §1.2 #57): only critical results reach
  // here (guarded above). Ordered behind the result's release (same aggregate).
  const ctx = await resultContext(tx, acked.labOrderId);
  await emitFacilityEvent(tx, {
    type: "CriticalResultAcknowledged", aggregateId: acked.id, aggregateType: "LAB_RESULT", facilityId: ctx.encounter.facilityId,
    actorUserId: byUserId, encounterId: ctx.encounterId,
    payload: {
      resultKind: "LAB", resultId: acked.id, patientId: ctx.patientId, acknowledgedByStaffId,
      minutesToAcknowledge: minutesBetween(acked.verifiedAt ?? acked.resultedAt, acked.acknowledgedAt!),
    },
  });
  return acked;
}

/** Guarded — a result can only move ENTERED -> VERIFIED once; concurrent double-verify is rejected, not silently accepted twice. */
export async function verifyResult(tx: Tx, resultId: string, verifiedByStaffId: string, byUserId?: string) {
  const updateResult = await tx.labResult.updateMany({
    where: { id: resultId, status: "ENTERED", isCurrent: true },
    data: { status: "VERIFIED", verifiedByStaffId, verifiedAt: new Date() },
  });
  if (updateResult.count !== 1) throw new ResultConcurrencyError("verified");
  const verified = await tx.labResult.findUniqueOrThrow({ where: { id: resultId } });
  // Phase D6 — verification is the "released" moment: emit LabResultReleased in
  // the same transaction. Tenant scope from the order's encounter; correlated
  // by the encounter (spine §1.0).
  const ctx = await resultContext(tx, verified.labOrderId);
  await emitFacilityEvent(tx, {
    type: "LabResultReleased", aggregateId: resultId, facilityId: ctx.encounter.facilityId, actorUserId: byUserId, encounterId: ctx.encounterId,
    payload: { resultId, orderId: verified.labOrderId, patientId: ctx.patientId, critical: verified.isCritical },
  });
  return verified;
}

/**
 * Amendment (brief §18). Never edits the verified row in place — creates a
 * new version, flips the old row to isCurrent:false/status:SUPERSEDED. The
 * previous version stays byte-for-byte readable via previousVersionId.
 */
export async function amendResult(
  tx: Tx,
  resultId: string,
  input: { value: string; unit?: string | null; numericValue?: number | null; isCritical?: boolean; reason: string; amendedByStaffId: string },
  byUserId?: string,
) {
  const original = await tx.labResult.findUnique({ where: { id: resultId } });
  if (!original) throw new NotFoundError("Result not found.");
  if (original.status !== "VERIFIED" || !original.isCurrent) throw new ResultNotAmendableError();

  const supersede = await tx.labResult.updateMany({
    where: { id: resultId, status: "VERIFIED", isCurrent: true },
    data: { isCurrent: false, status: "SUPERSEDED" },
  });
  if (supersede.count !== 1) throw new ResultConcurrencyError("amended");

  let abnormalFlag = original.abnormalFlag;
  if (original.catalogTestId && input.numericValue != null) {
    const range = await findApplicableReferenceRange(original.catalogTestId, null, null);
    abnormalFlag = computeAbnormalFlag(input.numericValue, range);
  }

  let amended;
  try {
    amended = await tx.labResult.create({
      data: {
        labOrderId: original.labOrderId,
        specimenId: original.specimenId,
        catalogTestId: original.catalogTestId,
        resultType: original.resultType,
        value: input.value,
        unit: input.unit ?? original.unit,
        numericValue: input.numericValue ?? original.numericValue,
        referenceRange: original.referenceRange,
        abnormalFlag: abnormalFlag ?? undefined,
        isCritical: input.isCritical ?? original.isCritical,
        releasedByStaffId: original.releasedByStaffId,
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
    if (isDuplicateCurrentResultError(err)) throw new ResultConcurrencyError("amended");
    throw err;
  }

  // DiagnosticReportAmended, on the original's aggregate so it is ordered
  // behind that result's release.
  const ctx = await resultContext(tx, original.labOrderId);
  await emitFacilityEvent(tx, {
    type: "DiagnosticReportAmended", aggregateId: original.id, aggregateType: "LAB_RESULT", facilityId: ctx.encounter.facilityId,
    actorUserId: byUserId, encounterId: ctx.encounterId,
    payload: { reportKind: "LAB", amendedId: amended.id, supersedesId: original.id, orderId: original.labOrderId, patientId: ctx.patientId, version: amended.version, critical: amended.isCritical },
  });
  return { original, amended };
}
