import { Prisma, LabResultType } from "@prisma/client";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { findApplicableReferenceRange, computeAbnormalFlag } from "./labCatalog";

type Tx = Prisma.TransactionClient;

export class ResultConcurrencyError extends BadRequestError {
  constructor(action: string) {
    super(`Result was already ${action} by someone else, or is no longer in the expected state. Refresh and try again.`);
  }
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

  const result = await tx.labResult.create({
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
    }
  } else {
    await tx.labOrder.updateMany({ where: { id: input.labOrderId, status: "IN_PROGRESS" }, data: { status: "RESULTED" } });
  }

  return result;
}

/** Guarded — a result can only move ENTERED -> VERIFIED once; concurrent double-verify is rejected, not silently accepted twice. */
export async function verifyResult(tx: Tx, resultId: string, verifiedByStaffId: string) {
  const updateResult = await tx.labResult.updateMany({
    where: { id: resultId, status: "ENTERED", isCurrent: true },
    data: { status: "VERIFIED", verifiedByStaffId, verifiedAt: new Date() },
  });
  if (updateResult.count !== 1) throw new ResultConcurrencyError("verified");
  return tx.labResult.findUniqueOrThrow({ where: { id: resultId } });
}

/**
 * Amendment (brief §18). Never edits the verified row in place — creates a
 * new version, flips the old row to isCurrent:false/status:SUPERSEDED. The
 * previous version stays byte-for-byte readable via previousVersionId.
 */
export async function amendResult(
  tx: Tx,
  resultId: string,
  input: { value: string; unit?: string | null; numericValue?: number | null; isCritical?: boolean; reason: string; amendedByStaffId: string }
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

  const amended = await tx.labResult.create({
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

  return { original, amended };
}
