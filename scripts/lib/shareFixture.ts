/**
 * Week 4c — fixtures shared by the consent-sharing gates
 * (verify-postgres-record-sharing, -access-requests, -sensitive-categories,
 * -revoke-all): synthetic people with records at Pune (and Noida), doctors,
 * and record entries written directly (the views read tables, not the index).
 */
import { randomBytes } from "node:crypto";
import type { PatientProvidedKind, Prisma } from "@prisma/client";
import { emitDomainEvent } from "../../src/lib/events/emit";
import { prisma } from "../../src/lib/db";
import { registerPatientAccount } from "../../src/lib/patient/selfRegistration";
import { dispatchPendingDomainEvents } from "../../src/lib/events/dispatcher";
import { emitFacilityEvent } from "../../src/lib/events/facilityEvent";
import { ensurePrimaryMembership } from "../../prisma/seedData/staffMembership";
import { linkAccountForGate } from "./personFixture";

export const PUNE = "fac-amc-pune";
export const NOIDA = "fac-amc-noida";
export const tag = `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
let seq = 0;

export function reporter() {
  let pass = 0, fail = 0;
  return {
    report(name: string, ok: boolean, detail?: string) {
      console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
      if (ok) pass += 1; else fail += 1;
    },
    async done() {
      console.log(`\n${pass} passed, ${fail} failed.`);
      await prisma.$disconnect();
      process.exit(fail === 0 ? 0 : 1);
    },
  };
}

export async function drain() {
  for (let i = 0; i < 40; i++) {
    const r = await dispatchPendingDomainEvents({ now: new Date(), batchSize: 500, maxDurationMs: 60_000 });
    if (r.claimed === 0) return;
  }
}

export async function staff(facilityId: string, role: "DOCTOR" | "NURSE" | "HOSPITAL_ADMIN" = "DOCTOR") {
  seq += 1;
  const dept = await prisma.department.findFirstOrThrow({ where: { facilityId }, select: { id: true } });
  const user = await prisma.user.create({ data: { email: `share-${role.toLowerCase()}-${tag}-${seq}@verify.aarogya`, passwordHash: "x", role, displayName: `Share ${role} ${seq}` } });
  const profile = await prisma.hospitalStaffProfile.create({ data: { userId: user.id, departmentId: dept.id, displayRole: role } });
  await ensurePrimaryMembership(prisma, user.id, facilityId, { isAdmin: role === "HOSPITAL_ADMIN" });
  return { userId: user.id, staffId: profile.id, facilityId, role, actor: { userId: user.id, facilityId, role } };
}

/** A person with a Pune record (and optionally a Noida one), each with an open encounter. */
export async function sharer(opts: { noida?: boolean } = {}) {
  seq += 1;
  const a = await registerPatientAccount({ facilityId: PUNE, fullName: `Share ${tag} ${seq}`, email: `share-${tag}-${seq}@verify.aarogya`, passwordHash: "x", sex: "F", dob: new Date("1983-03-03") });
  if (a.status !== "LINKED_NEW") throw new Error(`fixture person: ${a.status}`);
  const personId = (await prisma.personAccount.findUniqueOrThrow({ where: { userId: a.userId } })).personId;
  await prisma.person.update({ where: { id: personId }, data: { dataClassification: "SYNTHETIC" } });
  const pune = (await prisma.personPatientLink.findFirstOrThrow({ where: { personId, status: "ACTIVE" } })).patientId;
  const punEnc = await prisma.encounter.create({ data: { patientId: pune, facilityId: PUNE, type: "OPD", status: "IN_CONSULTATION", chiefComplaint: "share gate" } });
  let noida: string | null = null, noidaEnc: string | null = null;
  if (opts.noida) {
    noida = (await prisma.patient.create({ data: { uhid: `SHR-${tag}-${seq}`, facilityId: NOIDA, fullName: `Share ${tag} ${seq}`, sex: "F" } })).id;
    await linkAccountForGate(prisma, a.userId, noida);
    noidaEnc = (await prisma.encounter.create({ data: { patientId: noida, facilityId: NOIDA, type: "OPD", status: "IN_CONSULTATION", chiefComplaint: "share gate" } })).id;
  }
  return { userId: a.userId, personId, pune, punEnc: punEnc.id, noida, noidaEnc };
}

export async function lab(patientId: string, encounterId: string, testName: string, value: string, resultedAt = new Date()) {
  const p = await prisma.patient.findUniqueOrThrow({ where: { id: patientId }, select: { facilityId: true } });
  const author = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { department: { facilityId: p.facilityId } }, select: { id: true } });
  const order = await prisma.labOrder.create({ data: { encounterId, patientId, testName, category: "Pathology", orderedByStaffId: author.id } });
  const r = await prisma.labResult.create({ data: { labOrderId: order.id, value, status: "VERIFIED", resultedAt } });
  await prisma.$transaction((tx) => emitFacilityEvent(tx, { type: "LabResultReleased", aggregateId: r.id, facilityId: p.facilityId, payload: { resultId: r.id, orderId: order.id, patientId } }));
  return r.id;
}

export async function medicine(patientId: string, encounterId: string, drugName: string, orderedAt = new Date()) {
  const p = await prisma.patient.findUniqueOrThrow({ where: { id: patientId }, select: { facilityId: true } });
  const author = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { department: { facilityId: p.facilityId } }, select: { id: true } });
  return (await prisma.medicationOrder.create({ data: { encounterId, patientId, drugName, dose: "1 tab", route: "ORAL", frequency: "OD", orderedByStaffId: author.id, status: "ACTIVE", orderedAt } })).id;
}

export async function allergy(patientId: string, substance: string) {
  return (await prisma.allergy.create({ data: { patientId, substance, severity: "MODERATE" } })).id;
}

/** A confirmed patient-provided entry (as the pipeline's merge would write it). */
export async function provided(personId: string, kind: PatientProvidedKind, value: Record<string, unknown>, effectiveDate = new Date()) {
  const doc = await prisma.personDocument.create({ data: { personId, type: "REPORT", title: `Gate doc ${tag} ${++seq}`, storageRef: `gate/${tag}/${seq}`, sha256: "0".repeat(64), contentType: "application/pdf", uploadedByUserId: "gate" } });
  // With the event the merge emits, so the AI index picks it up as it would a real one.
  return prisma.$transaction(async (tx) => {
    const r = await tx.patientProvidedRecord.create({ data: { personId, kind, value: value as Prisma.InputJsonValue, factId: `gate-fact-${tag}-${seq}`, documentId: doc.id, pageNo: 1, effectiveDate } });
    await emitDomainEvent(tx, { type: "PatientProvidedRecordAdded", aggregateId: r.id, personId, payload: { recordId: r.id, personId, kind, factId: r.factId, documentId: doc.id } });
    return r.id;
  });
}

export const eventsOf = (aggregateId: string, type: string) => prisma.domainEventOutbox.findMany({ where: { aggregateId, eventType: type }, orderBy: { createdAt: "asc" } });
export const refused = <T>(p: Promise<T>) => p.then(() => false, () => true);
export const notFound = <T>(p: Promise<T>) => p.then(() => false, (e) => e?.constructor?.name === "NotFoundError");

// 4c fix: the new categories' entries (CONDITIONS, VITALS, CLINICAL_NOTES) and a real-looking upload.
async function authorAt(patientId: string) {
  const p = await prisma.patient.findUniqueOrThrow({ where: { id: patientId }, select: { facilityId: true } });
  return prisma.hospitalStaffProfile.findFirstOrThrow({ where: { department: { facilityId: p.facilityId } }, select: { id: true } });
}

export async function diagnosis(patientId: string, encounterId: string, text: string, opts: { code?: string; at?: Date } = {}) {
  const author = await authorAt(patientId);
  return (await prisma.diagnosis.create({ data: { patientId, encounterId, diagnosis: text, type: "FINAL", code: opts.code, codeSystem: opts.code ? "ICD-10" : undefined, diagnosedByStaffId: author.id, ...(opts.at ? { createdAt: opts.at } : {}) } })).id;
}

export async function problem(patientId: string, text: string, opts: { code?: string; at?: Date } = {}) {
  return (await prisma.problem.create({ data: { patientId, diagnosis: text, status: "ACTIVE", code: opts.code, codeSystem: opts.code ? "ICD-10" : undefined, ...(opts.at ? { createdAt: opts.at } : {}) } })).id;
}

export async function vital(encounterId: string, values: { hr?: number; sbp?: number; dbp?: number }, recordedAt = new Date()) {
  return (await prisma.vital.create({ data: { encounterId, recordedByStaffId: "gate", ...values, recordedAt } })).id;
}

export async function note(patientId: string, encounterId: string, text: string) {
  const author = await authorAt(patientId);
  return (await prisma.clinicalNote.create({ data: { encounterId, authorStaffId: author.id, type: "SOAP", content: { assessment: text }, status: "SIGNED", signedAt: new Date() } })).id;
}

/** A person's upload with a well-formed storage ref (the signed URL is a token over it; no bytes are needed). */
export async function upload(personId: string, title: string, opts: { type?: string; uploadedAt?: Date } = {}) {
  seq += 1;
  return (await prisma.personDocument.create({ data: { personId, type: opts.type ?? "REPORT", title, storageRef: `patient-uploads/${personId}/${seq.toString(16).padStart(16, "0")}-gate.pdf`, sha256: "1".repeat(64), contentType: "application/pdf", uploadedByUserId: "gate", ...(opts.uploadedAt ? { uploadedAt: opts.uploadedAt } : {}) } })).id;
}
