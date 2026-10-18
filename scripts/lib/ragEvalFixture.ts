/**
 * Week 4b — the synthetic patient the RAG evaluation asks about
 * (eval/rag/questions.json, fixture "rag-eval-v1"; docs/RAG_DESIGN.md §10.1).
 * Built through the services and the events the indexer consumes, so the
 * index is the one production would build. Every name and value is invented.
 */
import { prisma } from "../../src/lib/db";
import { registerPatientAccount } from "../../src/lib/patient/selfRegistration";
import { dispatchPendingDomainEvents } from "../../src/lib/events/dispatcher";
import { emitFacilityEvent } from "../../src/lib/events/facilityEvent";
import { createNote } from "../../src/lib/hospital/clinicalNote";
import { recordAllergy, recordDiagnosis, recordVitals, updateDiagnosis } from "../../src/lib/hospital/clinicalRecords";
import { createReferral } from "../../src/lib/hospital/referral";
import { decidePersonConsent } from "../../src/lib/person/consent";
import { uploadPersonDocument } from "../../src/lib/person/documents";
import { fixtureById, fixturePdf } from "../../src/lib/documents/fixtures";
import { bulkReview, listOwnFacts } from "../../src/lib/documents/review";
import type { AiActor } from "../../src/lib/rag/access";

export const EVAL_FACILITY = "fac-amc-pune";

export interface EvalFixture {
  patientId: string;
  actors: { doctor: AiActor; nurse: AiActor; patient: AiActor; doctorShare: AiActor };
  shareId: string;
  documents: Record<string, string>;
  appointments: Record<string, string>;
}

let clock = Date.now();
export async function drainEvents() {
  for (let i = 0; i < 40; i++) {
    clock += 2 * 3_600_000;
    const r = await dispatchPendingDomainEvents({ now: new Date(clock), batchSize: 500, maxDurationMs: 60_000 });
    if (r.claimed === 0) return;
  }
}

export async function buildEvalFixture(tag: string): Promise<EvalFixture> {
  const F = EVAL_FACILITY;
  const dept = await prisma.department.findFirstOrThrow({ where: { facilityId: F }, select: { id: true } });
  let n = 0;
  const mkStaff = async (role: "DOCTOR" | "NURSE") => {
    n += 1;
    const user = await prisma.user.create({ data: { email: `rag-eval-${role.toLowerCase()}-${tag}-${n}@verify.aarogya`, passwordHash: "x", role, displayName: `Eval ${role}` } });
    const p = await prisma.hospitalStaffProfile.create({ data: { userId: user.id, departmentId: dept.id, displayRole: role === "NURSE" ? "Ward Nurse" : "Physician" } });
    return { userId: user.id, staffId: p.id };
  };
  const doctor = await mkStaff("DOCTOR");
  const nurse = await mkStaff("NURSE");
  const reg = await registerPatientAccount({ facilityId: F, fullName: `Meera Iyer ${tag}`, email: `rag-eval-pt-${tag}@verify.aarogya`, passwordHash: "x", sex: "F", dob: new Date("1968-06-12") });
  if (reg.status !== "LINKED_NEW") throw new Error("eval fixture patient");
  const personId = (await prisma.personAccount.findUniqueOrThrow({ where: { userId: reg.userId } })).personId;
  await prisma.person.update({ where: { id: personId }, data: { dataClassification: "SYNTHETIC", preferredLanguage: "en" } });
  const patientId = (await prisma.personPatientLink.findFirstOrThrow({ where: { personId, status: "ACTIVE" } })).patientId;
  const enc = await prisma.encounter.create({ data: { patientId, facilityId: F, type: "OPD", status: "IN_CONSULTATION", chiefComplaint: "Cough and fever" } });
  const by = doctor.userId;

  await createNote({ encounterId: enc.id, authorStaffId: doctor.staffId, authorRole: "DOCTOR", type: "PROGRESS", content: { subjective: "Cough and fever for 3 days, productive sputum.", assessment: "Lower respiratory tract infection; diabetes on metformin.", plan: "Chest X-ray, CBC, azithromycin." }, sign: true, byUserId: by });
  const lab = async (testName: string, value: string, unit: string, range: string | null, flag: "LOW" | "HIGH" | "NORMAL", at: string) => {
    const order = await prisma.labOrder.create({ data: { encounterId: enc.id, patientId, testName, category: "Biochemistry", orderedByStaffId: doctor.staffId } });
    const r = await prisma.labResult.create({ data: { labOrderId: order.id, value, unit, referenceRange: range, abnormalFlag: flag, status: "VERIFIED", resultedAt: new Date(at) } });
    await prisma.$transaction((tx) => emitFacilityEvent(tx, { type: "LabResultReleased", aggregateId: r.id, facilityId: F, payload: { resultId: r.id, orderId: order.id, patientId } }));
    return { order, r };
  };
  await lab("Hemoglobin", "10.1", "g/dL", "12.0 - 15.5", "LOW", "2026-08-03T08:00:00Z");
  const hbLatest = await lab("Hemoglobin", "11.2", "g/dL", "12.0 - 15.5", "LOW", "2026-10-01T08:00:00Z");
  const cr = await lab("Serum creatinine", "1.52", "mg/dL", "0.70 - 1.30", "HIGH", "2026-10-01T08:00:00Z");
  const tsh = await lab("TSH", "6.8", "µIU/mL", "0.4 - 4.0", "HIGH", "2026-09-20T08:00:00Z");
  const a1c = await lab("HbA1c", "7.8", "%", "4.0 - 5.6", "HIGH", "2026-09-20T08:00:00Z");
  await lab("Potassium", "5.6", "mEq/L", "3.5 - 5.1", "HIGH", "2026-10-01T08:00:00Z");
  // The creatinine was amended (1.52 → 1.38).
  await prisma.labResult.update({ where: { id: cr.r.id }, data: { isCurrent: false, status: "SUPERSEDED" } });
  const cr2 = await prisma.labResult.create({ data: { labOrderId: cr.order.id, value: "1.38", unit: "mg/dL", referenceRange: "0.70 - 1.30", abnormalFlag: "HIGH", status: "AMENDED", version: 2, previousVersionId: cr.r.id, resultedAt: new Date("2026-10-01T08:00:00Z") } });
  await prisma.$transaction((tx) => emitFacilityEvent(tx, { type: "DiagnosticReportAmended", aggregateId: cr2.id, aggregateType: "LAB_RESULT", facilityId: F, payload: { reportKind: "LAB", amendedId: cr2.id, supersedesId: cr.r.id, orderId: cr.order.id, patientId, version: 2, critical: false } }));
  // The chest X-ray.
  const io = await prisma.imagingOrder.create({ data: { encounterId: enc.id, patientId, modality: "XRAY", studyDescription: "Chest PA view", orderedByStaffId: doctor.staffId } });
  const ir = await prisma.imagingReport.create({ data: { imagingOrderId: io.id, findings: "Homogeneous opacity in the right lower zone.", impression: "Findings suggest right lower zone consolidation.", reportedByStaffId: doctor.staffId, status: "VERIFIED", reportedAt: new Date("2026-10-01T10:00:00Z") } });
  await prisma.$transaction((tx) => emitFacilityEvent(tx, { type: "ImagingReportReleased", aggregateId: ir.id, facilityId: F, payload: { reportId: ir.id, patientId } }));
  // Diagnoses, allergy, vitals, medicines, a referral.
  await recordDiagnosis({ encounterId: enc.id, facilityId: F, staffId: doctor.staffId, diagnosis: "Type 2 diabetes mellitus", type: "FINAL", code: "E11.9", codeSystem: "ICD-10", byUserId: by });
  await recordDiagnosis({ encounterId: enc.id, facilityId: F, staffId: doctor.staffId, diagnosis: "Essential hypertension", type: "FINAL", code: "I10", codeSystem: "ICD-10", byUserId: by });
  const pn = await recordDiagnosis({ encounterId: enc.id, facilityId: F, staffId: doctor.staffId, diagnosis: "Community acquired pneumonia", type: "FINAL", code: "J18.9", codeSystem: "ICD-10", byUserId: by });
  await updateDiagnosis({ diagnosisId: pn.id, facilityId: F, status: "RESOLVED", byUserId: by });
  await recordAllergy({ patientId, facilityId: F, substance: "Penicillin", reaction: "urticarial rash", severity: "severe", byUserId: by });
  await recordVitals({ encounterId: enc.id, facilityId: F, staffId: nurse.staffId, vitals: { hr: 112, sbp: 150, dbp: 94, rr: 22, spo2: 91, tempC: 38.4 }, byUserId: by });
  const metformin = await prisma.medicationOrder.create({ data: { encounterId: enc.id, patientId, drugName: "Metformin", dose: "500 mg", route: "ORAL", frequency: "BD", orderedByStaffId: doctor.staffId, status: "ACTIVE" } });
  const azithro = await prisma.medicationOrder.create({ data: { encounterId: enc.id, patientId, drugName: "Azithromycin", dose: "500 mg", route: "ORAL", frequency: "OD", orderedByStaffId: doctor.staffId, status: "ACTIVE" } });
  await prisma.medicationAdministration.create({ data: { medicationOrderId: azithro.id, scheduledAt: new Date(Date.now() - 3 * 3_600_000), status: "MISSED" } });
  await prisma.medicationAdministration.create({ data: { medicationOrderId: metformin.id, scheduledAt: new Date(Date.now() + 2 * 3_600_000), status: "DUE" } });
  const cardio = await prisma.department.findFirst({ where: { facilityId: F, name: { contains: "ardio" } }, select: { id: true } });
  await createReferral({ encounterId: enc.id, facilityId: F, fromStaffId: doctor.staffId, toDepartmentId: (cardio ?? dept).id, reason: "Exertional chest discomfort", priority: "ROUTINE", byUserId: by });
  // An outside report, shared with the hospitals treating the patient, uploaded and confirmed.
  await decidePersonConsent({ userId: reg.userId, purpose: "SHARE_UPLOADS_WITH_TREATING", decision: "GRANTED" });
  const up = await uploadPersonDocument(reg.userId, { bytes: await fixturePdf(fixtureById("lab-hi-kft")!), contentType: "application/pdf", originalName: "kft.pdf", title: "Outside kidney function test", type: "REPORT" });
  await drainEvents();
  const facts = await listOwnFacts(reg.userId);
  await bulkReview(reg.userId, { decisions: facts.map((f) => ({ factId: f.id, version: f.version, decision: "CONFIRM" })) });
  // Appointments with their reasons; the nurse's assignment; a visit code for the share.
  const appt = async (reason: string) => (await prisma.appointment.create({ data: { facilityId: F, doctorStaffId: doctor.staffId, patientId, scheduledStart: new Date(Date.now() + 86_400_000), scheduledEnd: new Date(Date.now() + 86_400_000 + 900_000), createdByStaffId: doctor.staffId, reason } })).id;
  const appointments = { diabetes: await appt("Diabetes follow-up"), "chest infection": await appt("Chest infection review") };
  await prisma.nursingAssignment.create({ data: { facilityId: F, nurseStaffId: nurse.staffId, patientId, assignedByStaffId: doctor.staffId, startAt: new Date(Date.now() - 3_600_000) } });
  const shareDoc = await mkStaff("DOCTOR");
  const share = await prisma.patientAccessSession.create({ data: { patientId, codeHash: `rag-eval-${tag}`, status: "ACTIVE", doctorUserId: shareDoc.userId, doctorStaffId: shareDoc.staffId, facilityId: F, expiresAt: new Date(Date.now() + 3_600_000), activeExpiresAt: new Date(Date.now() + 3_600_000), redeemedAt: new Date() } });
  await drainEvents();
  return {
    patientId, shareId: share.id, appointments,
    actors: {
      doctor: { kind: "STAFF", userId: doctor.userId, role: "DOCTOR", facilityId: F },
      nurse: { kind: "STAFF", userId: nurse.userId, role: "NURSE", facilityId: F },
      patient: { kind: "PATIENT", userId: reg.userId },
      doctorShare: { kind: "STAFF", userId: shareDoc.userId, role: "DOCTOR", facilityId: F },
    },
    documents: { "lab:TSH": tsh.r.id, "lab:HbA1c": a1c.r.id, "lab:Hemoglobin:latest": hbLatest.r.id, "upload:kft": up.id },
  };
}
