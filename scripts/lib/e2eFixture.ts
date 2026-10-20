/**
 * Week 4c (4b follow-up b) — the browser smoke tests' fixture: synthetic
 * people only, uniquely tagged per run (the database is not reset).
 *   - a patient at the Pune demo facility (SYNTHETIC), with a login;
 *   - a doctor there, with an appointment with the patient today;
 *   - a small verified record (a released hemoglobin result, an allergy),
 *     indexed for the AI;
 *   - a visit code the patient issued and the doctor redeemed (an ACTIVE
 *     share), which the doctor's smoke opens;
 *   - a scan-like sample report PDF for the patient's smoke to upload.
 * Import only after DATABASE_URL points at the smoke database.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { prisma } from "../../src/lib/db";
import { hashPassword } from "../../src/lib/auth/password";
import { registerPatientAccount } from "../../src/lib/patient/selfRegistration";
import { dispatchPendingDomainEvents } from "../../src/lib/events/dispatcher";
import { registerAllConsumers } from "../../src/lib/runner/consumers";
import { emitFacilityEvent } from "../../src/lib/events/facilityEvent";
import { recordAllergy } from "../../src/lib/hospital/clinicalRecords";
import { issueAccessCode, redeemAccessCode } from "../../src/lib/patient/accessSession";
import { fixtureById, fixturePdf } from "../../src/lib/documents/fixtures";
import { ensurePrimaryMembership } from "../../prisma/seedData/staffMembership";

export const PUNE = "fac-amc-pune";

export interface E2eFixture {
  tag: string;
  password: string;
  patient: { email: string; patientId: string; name: string };
  doctor: { email: string; name: string };
  shareId: string;
  samplePdf: string;
  sampleTitle: string;
}

async function drain() {
  for (let i = 0; i < 40; i++) {
    const r = await dispatchPendingDomainEvents({ now: new Date(), batchSize: 500, maxDurationMs: 60_000 });
    if (r.claimed === 0) return;
  }
}

export async function buildE2eFixture(outDir: string): Promise<E2eFixture> {
  registerAllConsumers();
  const tag = `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
  const password = `Smoke-${tag}-pw1`;
  const hash = await hashPassword(password);
  if (!(await prisma.facility.findUnique({ where: { id: PUNE }, select: { id: true } }))) throw new Error(`The seed facility ${PUNE} is missing; seed the database first.`);

  // The doctor.
  const dept = await prisma.department.findFirstOrThrow({ where: { facilityId: PUNE }, select: { id: true } });
  const doctorName = `Dr. Smoke ${tag}`;
  const doctorUser = await prisma.user.create({ data: { email: `e2e-doctor-${tag}@verify.aarogya`, passwordHash: hash, role: "DOCTOR", displayName: doctorName } });
  const staff = await prisma.hospitalStaffProfile.create({ data: { userId: doctorUser.id, departmentId: dept.id, displayRole: "Physician" } });
  await ensurePrimaryMembership(prisma, doctorUser.id, PUNE, { isAdmin: false });

  // The patient (synthetic), with a phone unique to this run.
  const name = `Smoke Patient ${tag}`;
  const email = `e2e-patient-${tag}@verify.aarogya`;
  const phone = `9${String(parseInt(randomBytes(4).toString("hex"), 16) % 1_000_000_000).padStart(9, "0")}`;
  const a = await registerPatientAccount({ facilityId: PUNE, fullName: name, email, passwordHash: hash, sex: "F", dob: new Date("1984-02-02"), phone });
  if (a.status !== "LINKED_NEW") throw new Error(`fixture patient: ${a.status}`);
  const personId = (await prisma.personAccount.findUniqueOrThrow({ where: { userId: a.userId } })).personId;
  await prisma.person.update({ where: { id: personId }, data: { dataClassification: "SYNTHETIC", preferredLanguage: "en" } });
  const patientId = (await prisma.personPatientLink.findFirstOrThrow({ where: { personId, status: "ACTIVE" } })).patientId;

  // A small verified record, indexed for the AI.
  const enc = await prisma.encounter.create({ data: { patientId, facilityId: PUNE, type: "OPD", status: "IN_CONSULTATION", chiefComplaint: "Tiredness for two weeks" } });
  const order = await prisma.labOrder.create({ data: { encounterId: enc.id, patientId, testName: "Hemoglobin", category: "Hematology", orderedByStaffId: staff.id } });
  const hb = await prisma.labResult.create({ data: { labOrderId: order.id, value: "10.4", unit: "g/dL", referenceRange: "12.0 - 15.5", abnormalFlag: "LOW", status: "VERIFIED", resultedAt: new Date(Date.now() - 3 * 86_400_000) } });
  await prisma.$transaction((tx) => emitFacilityEvent(tx, { type: "LabResultReleased", aggregateId: hb.id, facilityId: PUNE, payload: { resultId: hb.id, orderId: order.id, patientId } }));
  await recordAllergy({ patientId, facilityId: PUNE, substance: "Penicillin", reaction: "rash", severity: "severe", byUserId: doctorUser.id });
  const start = new Date(Date.now() + 2 * 3_600_000);
  await prisma.appointment.create({ data: { facilityId: PUNE, doctorStaffId: staff.id, patientId, scheduledStart: start, scheduledEnd: new Date(start.getTime() + 900_000), createdByStaffId: staff.id, reason: "Follow-up for low hemoglobin" } });

  // The share: the patient's visit code, redeemed by the doctor.
  const issued = await issueAccessCode(patientId, a.userId, "E2E smoke visit");
  const redeemed = await redeemAccessCode({ code: issued.code, doctorUserId: doctorUser.id, doctorStaffId: staff.id, doctorName, facilityId: PUNE });
  if (!redeemed) throw new Error("fixture share: the code was not redeemed");
  await drain();

  mkdirSync(outDir, { recursive: true });
  const samplePdf = path.join(outDir, "sample-report.pdf");
  writeFileSync(samplePdf, await fixturePdf(fixtureById("lab-en-cbc")!));
  const fixture: E2eFixture = {
    tag, password, patient: { email, patientId, name }, doctor: { email: doctorUser.email, name: doctorName },
    shareId: redeemed.id, samplePdf, sampleTitle: `Blood count ${tag}`,
  };
  writeFileSync(path.join(outDir, "fixture.json"), JSON.stringify(fixture, null, 2));
  return fixture;
}
