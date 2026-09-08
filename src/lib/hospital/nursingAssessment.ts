import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";

export class AssessmentConcurrencyError extends BadRequestError {
  constructor(status: string) {
    super(`This assessment is already ${status} — refresh and try again.`);
  }
}

/**
 * Nursing assessment lifecycle (brief §6/§24-B): DRAFT -> COMPLETED ->
 * SIGNED -> SUPERSEDED. Every transition uses the guarded updateMany CAS
 * idiom (status in the WHERE, count-checked after) — the same pattern
 * medicationLifecycle.ts/bed.ts use — so two concurrent transitions on the
 * same assessment can never both "succeed". Structured findings are a
 * documentary JSON blob only; no scoring system or clinical decision logic
 * is implemented here.
 */
export async function createAssessment(input: {
  facilityId: string;
  patientId: string;
  encounterId: string;
  nurseStaffId: string;
  findings: unknown;
}) {
  return prisma.nursingAssessment.create({
    data: {
      facilityId: input.facilityId,
      patientId: input.patientId,
      encounterId: input.encounterId,
      nurseStaffId: input.nurseStaffId,
      findings: input.findings as never,
      status: "DRAFT",
    },
  });
}

export async function completeAssessment(input: { assessmentId: string; encounterId: string; findings?: unknown }) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.nursingAssessment.findUniqueOrThrow({ where: { id: input.assessmentId } });
    if (existing.encounterId !== input.encounterId) throw new NotFoundError("Nursing assessment not found.");
    if (existing.status !== "DRAFT") throw new AssessmentConcurrencyError(existing.status);

    const result = await tx.nursingAssessment.updateMany({
      where: { id: input.assessmentId, status: "DRAFT" },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        ...(input.findings !== undefined ? { findings: input.findings as never } : {}),
      },
    });
    if (result.count !== 1) throw new AssessmentConcurrencyError(existing.status);
    return tx.nursingAssessment.findUniqueOrThrow({ where: { id: input.assessmentId } });
  });
}

export async function signAssessment(input: { assessmentId: string; encounterId: string }) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.nursingAssessment.findUniqueOrThrow({ where: { id: input.assessmentId } });
    if (existing.encounterId !== input.encounterId) throw new NotFoundError("Nursing assessment not found.");
    if (existing.status !== "COMPLETED") throw new AssessmentConcurrencyError(existing.status);

    const result = await tx.nursingAssessment.updateMany({
      where: { id: input.assessmentId, status: "COMPLETED" },
      data: { status: "SIGNED", signedAt: new Date() },
    });
    if (result.count !== 1) throw new AssessmentConcurrencyError(existing.status);
    return tx.nursingAssessment.findUniqueOrThrow({ where: { id: input.assessmentId } });
  });
}

/**
 * Amends a SIGNED, current assessment: guards the old row (status=SIGNED
 * AND isCurrent=true) -> SUPERSEDED/isCurrent=false, then creates the new
 * SIGNED/isCurrent row in the same transaction. Both the status guard and
 * the isCurrent guard are needed together — otherwise two concurrent
 * amendments of the same assessment could each supersede it and each
 * create a "current" replacement, leaving two current versions.
 */
export async function amendAssessment(input: {
  assessmentId: string;
  encounterId: string;
  nurseStaffId: string;
  findings: unknown;
  amendmentReason: string;
}) {
  return prisma.$transaction(async (tx) => {
    const old = await tx.nursingAssessment.findUniqueOrThrow({ where: { id: input.assessmentId } });
    if (old.encounterId !== input.encounterId) throw new NotFoundError("Nursing assessment not found.");
    if (old.status !== "SIGNED" || !old.isCurrent) throw new AssessmentConcurrencyError(old.status);

    const result = await tx.nursingAssessment.updateMany({
      where: { id: input.assessmentId, status: "SIGNED", isCurrent: true },
      data: { status: "SUPERSEDED", isCurrent: false, amendedAt: new Date(), amendmentReason: input.amendmentReason },
    });
    if (result.count !== 1) throw new AssessmentConcurrencyError(old.status);

    return tx.nursingAssessment.create({
      data: {
        facilityId: old.facilityId,
        patientId: old.patientId,
        encounterId: old.encounterId,
        nurseStaffId: input.nurseStaffId,
        findings: input.findings as never,
        status: "SIGNED",
        version: old.version + 1,
        isCurrent: true,
        previousVersionId: old.id,
        signedAt: new Date(),
      },
    });
  });
}
