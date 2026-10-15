import type { EncounterType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";

/**
 * Open an encounter for a patient of this facility (POST
 * /api/hospital/encounters), emitting EncounterOpened in the same transaction.
 */
export async function openEncounter(input: {
  facilityId: string;
  patientId: string;
  type: EncounterType;
  departmentId?: string;
  chiefComplaint?: string;
  byUserId: string;
}) {
  const patient = await prisma.patient.findUnique({ where: { id: input.patientId }, select: { facilityId: true } });
  if (!patient || patient.facilityId !== input.facilityId) throw new BadRequestError("Patient not found in this facility.");

  const encounter = await prisma.$transaction(async (tx) => {
    const created = await tx.encounter.create({
      data: {
        patientId: input.patientId,
        facilityId: input.facilityId,
        type: input.type,
        departmentId: input.departmentId,
        chiefComplaint: input.chiefComplaint,
      },
    });
    await emitFacilityEvent(tx, {
      type: "EncounterOpened", aggregateId: created.id, facilityId: input.facilityId, actorUserId: input.byUserId, encounterId: created.id,
      payload: { encounterId: created.id, patientId: input.patientId, encounterType: created.type, accessSource: created.accessSource ?? undefined },
    });
    return created;
  });
  await recordAuditEvent(
    "hospital.encounter.registered",
    input.byUserId,
    { encounterId: encounter.id, type: encounter.type },
    { facilityId: input.facilityId, patientId: input.patientId, encounterId: encounter.id }
  );
  return encounter;
}
