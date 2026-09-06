import { Prisma, PayerType } from "@prisma/client";
import { BadRequestError } from "@/lib/auth/rbac";
import { dateRangesOverlap } from "./pricing";

type Tx = Prisma.TransactionClient;

export class OverlappingPrimaryCoverageError extends BadRequestError {
  constructor() {
    super("This patient already has an active primary coverage for an overlapping period.");
  }
}

export async function createPayer(tx: Tx, input: { name: string; type: PayerType }) {
  return tx.payer.create({ data: { name: input.name, type: input.type } });
}

export async function createPayerPlan(tx: Tx, input: { payerId: string; name: string; planCode?: string; copayPercent?: number }) {
  return tx.payerPlan.create({ data: { payerId: input.payerId, name: input.name, planCode: input.planCode, copayPercent: input.copayPercent } });
}

/** Pure validity predicate — extracted so it's unit-testable without a DB, same convention as tariffRangesOverlap/isStudyTransitionAllowed. */
export function isCoverageValid(coverage: { status: string; validFrom: Date; validTo: Date | null }, atDate: Date): boolean {
  if (coverage.status !== "ACTIVE") return false;
  if (coverage.validFrom > atDate) return false;
  if (coverage.validTo !== null && coverage.validTo <= atDate) return false;
  return true;
}

/**
 * Adds coverage for a patient. Validates against overlapping ACTIVE
 * primary (priorityOrder=1) coverage for the same patient — a patient can
 * have at most one primary payer active at a time, though multiple
 * secondary payers (priorityOrder 2+) are legal simultaneously. App-level
 * check only this phase (no DB exclusion constraint) — documented, not a
 * silent gap.
 */
export async function addPatientCoverage(
  tx: Tx,
  input: {
    patientId: string;
    payerId: string;
    planId?: string;
    memberId: string;
    validFrom: Date;
    validTo?: Date | null;
    priorityOrder?: number;
    addedByUserId: string;
  }
) {
  const priorityOrder = input.priorityOrder ?? 1;
  if (priorityOrder === 1) {
    const existingPrimary = await tx.patientCoverage.findMany({
      where: { patientId: input.patientId, priorityOrder: 1, status: "ACTIVE" },
      select: { validFrom: true, validTo: true },
    });
    const overlaps = existingPrimary.some((c) => dateRangesOverlap(input.validFrom, input.validTo ?? null, c.validFrom, c.validTo));
    if (overlaps) throw new OverlappingPrimaryCoverageError();
  }

  return tx.patientCoverage.create({
    data: {
      patientId: input.patientId,
      payerId: input.payerId,
      planId: input.planId,
      memberId: input.memberId,
      validFrom: input.validFrom,
      validTo: input.validTo ?? null,
      priorityOrder,
      addedByUserId: input.addedByUserId,
    },
  });
}

export async function deactivateCoverage(tx: Tx, coverageId: string) {
  return tx.patientCoverage.update({ where: { id: coverageId }, data: { status: "INACTIVE" } });
}
