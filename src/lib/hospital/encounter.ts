import type { EncounterType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";

/**
 * Open an encounter for a patient of this facility (POST
 * /api/hospital/encounters). EncounterOpened is wired here in §9 step 4.
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

  const encounter = await prisma.encounter.create({
    data: {
      patientId: input.patientId,
      facilityId: input.facilityId,
      type: input.type,
      departmentId: input.departmentId,
      chiefComplaint: input.chiefComplaint,
    },
  });
  await recordAuditEvent(
    "hospital.encounter.registered",
    input.byUserId,
    { encounterId: encounter.id, type: encounter.type },
    { facilityId: input.facilityId, patientId: input.patientId, encounterId: encounter.id }
  );
  return encounter;
}
