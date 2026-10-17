import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { isStaffInFacility } from "@/lib/auth/staffFacility";

/**
 * Encounter bookkeeping that was written by routes (batch 7, item 5): the
 * triage level and attending clinician on the encounter row, the encounter's
 * physical location, and episodes of care. Status changes go through
 * transitionEncounter (which emits); bed placement is AdmissionCreated /
 * PatientTransferred. These rows drive no reaction, so they emit nothing
 * (OPERATIONAL_DETAIL in emitExemptions.ts).
 */
export async function updateEncounterDetails(input: { encounterId: string; facilityId: string; triageLevel?: number; attendingStaffId?: string }) {
  if (input.triageLevel !== undefined && (input.triageLevel < 1 || input.triageLevel > 5)) {
    throw new BadRequestError("triageLevel must be between 1 (resuscitation) and 5 (non-urgent).");
  }
  const enc = await prisma.encounter.findUnique({ where: { id: input.encounterId }, select: { facilityId: true } });
  if (!enc || enc.facilityId !== input.facilityId) throw new NotFoundError("Encounter not found.");
  // Batch 7: the attending clinician must be staff of this facility (any id was accepted).
  if (input.attendingStaffId && !(await isStaffInFacility(prisma, input.attendingStaffId, input.facilityId))) throw new NotFoundError("Staff member not found in this facility.");
  if (input.triageLevel === undefined && !input.attendingStaffId) return;
  await prisma.encounter.update({
    where: { id: input.encounterId },
    data: { ...(input.triageLevel !== undefined ? { triageLevel: input.triageLevel } : {}), ...(input.attendingStaffId ? { attendingStaffId: input.attendingStaffId } : {}) },
  });
}

export async function assignEncounterLocation(input: { encounterId: string; facilityId: string; bedId?: string; areaLabel?: string; staffId?: string | null }) {
  if (!input.bedId && !input.areaLabel) throw new BadRequestError("bedId or areaLabel is required.");
  return prisma.$transaction(async (tx) => {
    const enc = await tx.encounter.findUnique({ where: { id: input.encounterId }, select: { facilityId: true } });
    if (!enc || enc.facilityId !== input.facilityId) throw new NotFoundError("Encounter not found.");
    // Batch 7: the bed must be this facility's (any id was accepted).
    if (input.bedId) {
      const bed = await tx.bed.findUnique({ where: { id: input.bedId }, select: { facilityId: true } });
      if (!bed || bed.facilityId !== input.facilityId) throw new NotFoundError("Bed not found in this facility.");
    }
    await tx.encounterLocation.updateMany({ where: { encounterId: input.encounterId, releasedAt: null }, data: { releasedAt: new Date() } });
    return tx.encounterLocation.create({
      data: { encounterId: input.encounterId, facilityId: input.facilityId, bedId: input.bedId, areaLabel: input.areaLabel, assignedByStaffId: input.staffId ?? undefined },
    });
  });
}

export async function createEpisodeOfCare(input: { patientId: string; facilityId: string; title: string; type: string; reason?: string }) {
  if (!input.patientId || !input.title || !input.type) throw new BadRequestError("patientId, title and type are required.");
  const patient = await prisma.patient.findUnique({ where: { id: input.patientId }, select: { facilityId: true } });
  if (!patient || patient.facilityId !== input.facilityId) throw new NotFoundError("Patient not found.");
  return prisma.episodeOfCare.create({ data: { patientId: input.patientId, facilityId: input.facilityId, title: input.title, type: input.type, reason: input.reason } });
}
