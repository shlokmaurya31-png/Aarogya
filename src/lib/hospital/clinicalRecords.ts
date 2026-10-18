import { $Enums, type Prisma, type DiagnosisStatus, type AllergyStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { parseEnum, parseOptionalEnum } from "@/lib/enumValue";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";
import { normalizeCode } from "./problemList";
import { findAbnormalVitals, type AbnormalVital } from "./vitalsThresholds";

type Tx = Prisma.TransactionClient;

/**
 * Point-of-care clinical records that were written by their routes (batch 7,
 * item 1): vitals and intake/output (ObservationRecorded v2, kinds VITALS,
 * INTAKE, OUTPUT), diagnoses (DiagnosisRecorded) and allergies
 * (AllergyListUpdated). Each write emits in its own transaction; payloads carry
 * IDs and closed codes only, never a value, a diagnosis text or code, a
 * substance, a reaction or a note.
 */

async function encounterIn(tx: Tx, encounterId: string, facilityId: string) {
  const enc = await tx.encounter.findUnique({ where: { id: encounterId }, select: { id: true, facilityId: true, patientId: true } });
  if (!enc || enc.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");
  return enc;
}

// ── Vitals and intake/output ────────────────────────────────────────────────

export interface VitalsInput {
  hr?: number; sbp?: number; dbp?: number; rr?: number; spo2?: number; tempC?: number; painScore?: number;
  consciousness?: string; o2DeliveryMethod?: string; o2FlowRate?: number;
}

/** Records a vitals set. `abnormal` (facility-configured thresholds only) is a flag on the event, never the values. */
export async function recordVitals(input: { encounterId: string; facilityId: string; staffId: string; vitals: VitalsInput; byUserId: string }): Promise<{ vital: Prisma.VitalGetPayload<object>; abnormal: AbnormalVital[] }> {
  const v = input.vitals;
  const abnormal = await findAbnormalVitals(input.facilityId, { hr: v.hr ?? null, sbp: v.sbp ?? null, dbp: v.dbp ?? null, rr: v.rr ?? null, spo2: v.spo2 ?? null, tempC: v.tempC ?? null });
  const vital = await prisma.$transaction(async (tx) => {
    const enc = await encounterIn(tx, input.encounterId, input.facilityId);
    const created = await tx.vital.create({
      data: {
        encounterId: enc.id, recordedByStaffId: input.staffId, hr: v.hr, sbp: v.sbp, dbp: v.dbp, rr: v.rr, spo2: v.spo2, tempC: v.tempC,
        painScore: v.painScore, consciousness: v.consciousness, o2DeliveryMethod: v.o2DeliveryMethod, o2FlowRate: v.o2FlowRate,
      },
    });
    await emitFacilityEvent(tx, {
      type: "ObservationRecorded", aggregateId: created.id, facilityId: enc.facilityId, encounterId: enc.id, actorUserId: input.byUserId,
      payload: { observationId: created.id, encounterId: enc.id, patientId: enc.patientId, observationKind: "VITALS", abnormal: abnormal.length > 0 },
    });
    return created;
  });
  return { vital, abnormal };
}

export async function recordIntakeOutput(input: { encounterId: string; facilityId: string; staffId: string; ioType: "INPUT" | "OUTPUT"; category: string; quantityMl: number; notes?: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const enc = await encounterIn(tx, input.encounterId, input.facilityId);
    const record = await tx.intakeOutputRecord.create({
      data: { encounterId: enc.id, facilityId: input.facilityId, ioType: input.ioType, category: input.category, quantityMl: input.quantityMl, recordedByStaffId: input.staffId, notes: input.notes },
    });
    await emitFacilityEvent(tx, {
      type: "ObservationRecorded", aggregateId: record.id, facilityId: enc.facilityId, encounterId: enc.id, actorUserId: input.byUserId,
      payload: { observationId: record.id, encounterId: enc.id, patientId: enc.patientId, observationKind: input.ioType === "INPUT" ? "INTAKE" : "OUTPUT" },
    });
    return record;
  });
}

// ── Diagnoses ───────────────────────────────────────────────────────────────

export const DIAGNOSIS_TYPES = ["PRIMARY", "SECONDARY", "PROVISIONAL", "RULE_OUT", "FINAL"] as const;

async function emitDiagnosis(tx: Tx, d: { id: string; encounterId: string; patientId: string; type: string; status: DiagnosisStatus; code: string | null }, action: "ADDED" | "UPDATED" | "RESOLVED", facilityId: string, byUserId: string) {
  await emitFacilityEvent(tx, {
    type: "DiagnosisRecorded", aggregateId: d.id, facilityId, encounterId: d.encounterId, actorUserId: byUserId,
    payload: { diagnosisId: d.id, encounterId: d.encounterId, patientId: d.patientId, action, diagnosisType: d.type, status: d.status, coded: d.code !== null },
  });
}

export async function recordDiagnosis(input: {
  encounterId: string; facilityId: string; staffId: string; diagnosis: string; type: string; onsetDate?: Date;
  codeSystem?: string | null; code?: string | null; codeDisplay?: string | null; byUserId: string;
}) {
  if (!input.diagnosis || !(DIAGNOSIS_TYPES as readonly string[]).includes(input.type)) {
    throw new BadRequestError(`diagnosis is required and type must be one of ${DIAGNOSIS_TYPES.join(", ")}.`);
  }
  const coded = normalizeCode({ codeSystem: input.codeSystem, code: input.code, codeDisplay: input.codeDisplay });
  return prisma.$transaction(async (tx) => {
    const enc = await encounterIn(tx, input.encounterId, input.facilityId);
    const created = await tx.diagnosis.create({
      data: { patientId: enc.patientId, encounterId: enc.id, diagnosis: input.diagnosis, type: input.type, onsetDate: input.onsetDate, ...coded, diagnosedByStaffId: input.staffId },
    });
    await emitDiagnosis(tx, created, "ADDED", enc.facilityId, input.byUserId);
    return created;
  });
}

/** Changes a diagnosis's type and/or status, compare-and-set on the status read. RESOLVED is its own action. */
export async function updateDiagnosis(input: { diagnosisId: string; facilityId: string; type?: string; status?: string; byUserId: string }) {
  const status = parseOptionalEnum($Enums.DiagnosisStatus, input.status, "status");
  if (input.type !== undefined && !(DIAGNOSIS_TYPES as readonly string[]).includes(input.type)) throw new BadRequestError(`type must be one of ${DIAGNOSIS_TYPES.join(", ")}.`);
  if (status === undefined && input.type === undefined) throw new BadRequestError("Nothing to change: give a type or a status.");
  return prisma.$transaction(async (tx) => {
    const d = await tx.diagnosis.findUnique({ where: { id: input.diagnosisId }, include: { encounter: { select: { facilityId: true } } } });
    if (!d || d.encounter.facilityId !== input.facilityId) throw new NotFoundError("Diagnosis not found.");
    if (d.status !== "ACTIVE") throw new BadRequestError(`A ${d.status} diagnosis can't be changed; record a new one.`);
    const r = await tx.diagnosis.updateMany({ where: { id: d.id, status: d.status }, data: { ...(status ? { status } : {}), ...(input.type ? { type: input.type } : {}) } });
    if (r.count !== 1) throw new BadRequestError("The diagnosis changed concurrently. Refresh and try again.");
    const updated = await tx.diagnosis.findUniqueOrThrow({ where: { id: d.id } });
    await emitDiagnosis(tx, updated, updated.status === "RESOLVED" ? "RESOLVED" : "UPDATED", input.facilityId, input.byUserId);
    return updated;
  });
}

// ── Allergies ───────────────────────────────────────────────────────────────

async function patientIn(tx: Tx, patientId: string, facilityId: string) {
  const patient = await tx.patient.findUnique({ where: { id: patientId }, select: { id: true, facilityId: true } });
  if (!patient || patient.facilityId !== facilityId) throw new NotFoundError("Patient not found.");
  return patient;
}

async function emitAllergy(tx: Tx, a: { id: string; patientId: string; status: AllergyStatus; severity: string | null; verification: string; criticality: string | null; source: "CLINICIAN" | "PATIENT_PROVIDED" }, action: "ADDED" | "UPDATED" | "INACTIVATED", facilityId: string, byUserId: string) {
  await emitFacilityEvent(tx, {
    type: "AllergyListUpdated", aggregateId: a.id, facilityId, actorUserId: byUserId,
    payload: {
      allergyId: a.id, patientId: a.patientId, action, status: a.status, ...(a.severity ? { severity: a.severity } : {}), verification: a.verification,
      ...(a.criticality ? { criticality: a.criticality } : {}), source: a.source,
    },
  });
}

export async function recordAllergy(input: { patientId: string; facilityId: string; substance: string; reaction?: string; severity: string; criticality?: string; verification?: string; byUserId: string }) {
  if (!input.substance || !input.severity) throw new BadRequestError("substance and severity are required.");
  // The chart sends lowercase (mild/moderate/severe); stored as the Severity enum.
  const severity = parseEnum($Enums.Severity, String(input.severity).toUpperCase(), "severity");
  const criticality = parseOptionalEnum($Enums.AllergyCriticality, input.criticality, "criticality");
  const verification = parseEnum($Enums.AllergyVerification, input.verification ?? "UNCONFIRMED", "verification");
  return prisma.$transaction(async (tx) => {
    const patient = await patientIn(tx, input.patientId, input.facilityId);
    const allergy = await tx.allergy.create({ data: { patientId: patient.id, substance: input.substance, reaction: input.reaction, status: "ACTIVE", severity, criticality, verification } });
    await emitAllergy(tx, allergy, "ADDED", input.facilityId, input.byUserId);
    return allergy;
  });
}

/** Changes an allergy, compare-and-set on the status read. INACTIVE or ENTERED_IN_ERROR is INACTIVATED. */
export async function updateAllergy(input: { allergyId: string; facilityId: string; status?: string; severity?: string; criticality?: string; verification?: string; byUserId: string }) {
  const status = parseOptionalEnum($Enums.AllergyStatus, input.status, "status");
  const severity = input.severity ? parseEnum($Enums.Severity, String(input.severity).toUpperCase(), "severity") : undefined;
  const criticality = parseOptionalEnum($Enums.AllergyCriticality, input.criticality, "criticality");
  const verification = parseOptionalEnum($Enums.AllergyVerification, input.verification, "verification");
  if (!status && !severity && !criticality && !verification) throw new BadRequestError("Nothing to change.");
  return prisma.$transaction(async (tx) => {
    const a = await tx.allergy.findUnique({ where: { id: input.allergyId } });
    if (!a) throw new NotFoundError("Allergy not found.");
    await patientIn(tx, a.patientId, input.facilityId);
    if (a.status !== "ACTIVE") throw new BadRequestError(`An ${a.status} allergy can't be changed; record it again.`);
    const r = await tx.allergy.updateMany({ where: { id: a.id, status: a.status }, data: { ...(status ? { status } : {}), ...(severity ? { severity } : {}), ...(criticality ? { criticality } : {}), ...(verification ? { verification } : {}) } });
    if (r.count !== 1) throw new BadRequestError("The allergy changed concurrently. Refresh and try again.");
    const updated = await tx.allergy.findUniqueOrThrow({ where: { id: a.id } });
    await emitAllergy(tx, updated, updated.status === "ACTIVE" ? "UPDATED" : "INACTIVATED", input.facilityId, input.byUserId);
    return updated;
  });
}
