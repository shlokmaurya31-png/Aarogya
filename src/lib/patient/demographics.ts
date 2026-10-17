import { prisma } from "@/lib/db";
import { NotFoundError } from "@/lib/auth/rbac";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";
import { notifyPreviousPhone } from "@/lib/person/linking";

/**
 * Staff edits to a patient's record (batch 7, item 5; previously written by
 * the routes). PatientDemographicsUpdated v2 names which fields changed (or
 * that an emergency contact was added), never their values.
 */
const FIELD_CODES = {
  fullName: "FULL_NAME", preferredName: "PREFERRED_NAME", phone: "PHONE", address: "ADDRESS",
  bloodGroup: "BLOOD_GROUP", language: "LANGUAGE", deceasedAt: "DECEASED",
} as const;

export async function updatePatientRecord(input: {
  patientId: string; facilityId: string; byUserId: string;
  changes: { fullName?: string; preferredName?: string; phone?: string; address?: string; bloodGroup?: string; language?: string; deceasedAt?: Date | null };
}) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.patient.findUnique({ where: { id: input.patientId } });
    if (!before || before.facilityId !== input.facilityId) throw new NotFoundError("Patient not found.");
    const data = Object.fromEntries(Object.entries(input.changes).filter(([, v]) => v !== undefined));
    // Phase 0: staff entering a (new) phone with the patient present confirms it.
    const phoneChanged = "phone" in data && String(data.phone ?? "") !== String(before.phone ?? "");
    // Insider-takeover fix: a staff phone change starts the code-link hold.
    const patient = await tx.patient.update({ where: { id: before.id }, data: { ...data, ...(phoneChanged ? { phoneConfirmedAt: data.phone ? new Date() : null, phoneSetByStaffAt: new Date() } : {}) } });
    const fields = (Object.keys(FIELD_CODES) as (keyof typeof FIELD_CODES)[])
      .filter((k) => k in data && String(data[k] ?? "") !== String((before as Record<string, unknown>)[k] ?? ""))
      .map((k) => FIELD_CODES[k]);
    if (fields.length) {
      await emitFacilityEvent(tx, {
        type: "PatientDemographicsUpdated", aggregateId: before.id, facilityId: before.facilityId, actorUserId: input.byUserId,
        payload: { patientId: before.id, changeKind: "PROFILE", fields },
      });
    }
    return { patient, previousPhone: phoneChanged ? before.phone : null };
  }).then(async ({ patient, previousPhone }) => {
    // Every phone change tells the previous number (no clinical or facility detail).
    if (previousPhone) await notifyPreviousPhone({ patientId: patient.id, facilityId: patient.facilityId, previousPhone, changedBy: "STAFF", byUserId: input.byUserId });
    return patient;
  });
}

export async function addEmergencyContact(input: { patientId: string; facilityId: string; name: string; relation: string; phone: string; priority?: number; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const patient = await tx.patient.findUnique({ where: { id: input.patientId }, select: { id: true, facilityId: true } });
    if (!patient || patient.facilityId !== input.facilityId) throw new NotFoundError("Patient not found.");
    const contact = await tx.patientEmergencyContact.create({ data: { patientId: patient.id, name: input.name, relation: input.relation, phone: input.phone, priority: input.priority ?? 1 } });
    await emitFacilityEvent(tx, {
      type: "PatientDemographicsUpdated", aggregateId: patient.id, facilityId: patient.facilityId, actorUserId: input.byUserId,
      payload: { patientId: patient.id, changeKind: "EMERGENCY_CONTACT_ADDED" },
    });
    return contact;
  });
}
