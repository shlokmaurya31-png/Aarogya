import { prisma } from "@/lib/db";

/** Medication reconciliation (brief §19) — purely additive rows; never deletes or mutates prior medication history. */
export async function recordReconciliation(input: {
  encounterId: string;
  patientId: string;
  facilityId: string;
  source: "ADMISSION" | "TRANSFER" | "DISCHARGE";
  medicationName: string;
  priorDose?: string;
  decision: "CONTINUED" | "MODIFIED" | "STOPPED" | "NEW";
  medicationOrderId?: string;
  reason?: string;
  reviewedByStaffId: string;
  byUserId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const record = await tx.medicationReconciliation.create({
      data: {
        encounterId: input.encounterId,
        patientId: input.patientId,
        facilityId: input.facilityId,
        source: input.source,
        medicationName: input.medicationName,
        priorDose: input.priorDose,
        decision: input.decision,
        medicationOrderId: input.medicationOrderId,
        reason: input.reason,
        reviewedByStaffId: input.reviewedByStaffId,
      },
    });
    await tx.auditEvent.create({ data: { type: "hospital.medication.reconciled", userId: input.byUserId, detail: { reconciliationId: record.id, source: input.source, decision: input.decision } } });
    return record;
  });
}
