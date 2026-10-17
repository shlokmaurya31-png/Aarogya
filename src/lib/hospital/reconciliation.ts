import { prisma } from "@/lib/db";
import { NotFoundError } from "@/lib/auth/rbac";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";

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
    // The event is facility-scoped: the encounter must be this patient's, in this facility.
    const enc = await tx.encounter.findUnique({ where: { id: input.encounterId }, select: { facilityId: true, patientId: true } });
    if (!enc || enc.facilityId !== input.facilityId || enc.patientId !== input.patientId) throw new NotFoundError("Encounter not found.");
    if (input.medicationOrderId) {
      const order = await tx.medicationOrder.findUnique({ where: { id: input.medicationOrderId }, select: { patientId: true } });
      if (!order || order.patientId !== input.patientId) throw new NotFoundError("Medication order not found for this patient.");
    }
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
    await emitFacilityEvent(tx, {
      type: "MedicationReconciliationRecorded", aggregateId: record.id, facilityId: input.facilityId, actorUserId: input.byUserId, encounterId: input.encounterId,
      payload: {
        reconciliationId: record.id, encounterId: input.encounterId, patientId: input.patientId, source: input.source, decision: input.decision,
        ...(input.medicationOrderId ? { medicationOrderId: input.medicationOrderId } : {}),
      },
    });
    return record;
  });
}
