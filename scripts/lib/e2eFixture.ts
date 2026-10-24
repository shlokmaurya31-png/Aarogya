/**
 * Week 4c (4b follow-up b) — the browser smoke tests' fixture: synthetic
 * people only, uniquely tagged per run (the database is not reset).
 *   - a patient at the Pune demo facility (SYNTHETIC), with a login;
 *   - a doctor there, with an appointment with the patient today;
 *   - a small verified record (a released hemoglobin result, an allergy),
 *     indexed for the AI;
 *   - a visit code the patient issued and the doctor redeemed (an ACTIVE
 *     share), which the doctor's smoke opens;
 *   - a scan-like sample report PDF for the patient's smoke to upload;
 *   - Week 5b: the patient's own verified phone (a household's parental consent);
 *   - Week 5a: a verified, listed general physician in the directory (a
 *     hospital location at Pune with sessions all day, so a slot is always
 *     inside the booking share's window), with a login.
 *   - Week 5c: the visit two hours ahead (inside the pre-arrival window),
 *     the facility admin's login (the desk), and the Pune facility's own
 *     test-mode payment gateway (secrets from this run's environment).
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
import { registerDoctor, updateOwnProfile } from "../../src/lib/doctors/profile";
import { decideVerification, submitVerification } from "../../src/lib/doctors/verification";
import { addHospitalLocation, claimStaffProfile, decideStaffLink } from "../../src/lib/doctors/locations";
import { refreshNextSlot } from "../../src/lib/doctors/slots";

export const PUNE = "fac-amc-pune";
/** Week 5c: the smoke run's gateway secrets live under this reference (scripts/e2e-smoke.ts sets them). */
export const E2E_GATEWAY_REF = "E2E_SMOKE";

export interface E2eFixture {
  tag: string;
  password: string;
  patient: { email: string; patientId: string; name: string; verifiedPhone: string };
  doctor: { email: string; name: string };
  networkDoctor: { email: string; name: string };
  /** Week 5c: the facility admin (the desk), the visit to check in for, the gateway's secret reference. */
  desk: { email: string };
  appointmentId: string;
  gatewaySecretRef: string;
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
  // Week 5b: a verified phone of the person's own (where a household's parental-consent code goes).
  const verifiedPhone = `+91${phone}`;
  await prisma.personContact.create({ data: { personId, kind: "PHONE", value: verifiedPhone, verifiedAt: new Date() } });

  // A small verified record, indexed for the AI.
  const enc = await prisma.encounter.create({ data: { patientId, facilityId: PUNE, type: "OPD", status: "IN_CONSULTATION", chiefComplaint: "Tiredness for two weeks" } });
  const order = await prisma.labOrder.create({ data: { encounterId: enc.id, patientId, testName: "Hemoglobin", category: "Hematology", orderedByStaffId: staff.id } });
  const hb = await prisma.labResult.create({ data: { labOrderId: order.id, value: "10.4", unit: "g/dL", referenceRange: "12.0 - 15.5", abnormalFlag: "LOW", status: "VERIFIED", resultedAt: new Date(Date.now() - 3 * 86_400_000) } });
  await prisma.$transaction((tx) => emitFacilityEvent(tx, { type: "LabResultReleased", aggregateId: hb.id, facilityId: PUNE, payload: { resultId: hb.id, orderId: order.id, patientId } }));
  await recordAllergy({ patientId, facilityId: PUNE, substance: "Penicillin", reaction: "rash", severity: "severe", byUserId: doctorUser.id });
  const start = new Date(Date.now() + 2 * 3_600_000);
  const appointment = await prisma.appointment.create({ data: { facilityId: PUNE, doctorStaffId: staff.id, patientId, scheduledStart: start, scheduledEnd: new Date(start.getTime() + 900_000), createdByStaffId: staff.id, reason: "Follow-up for low hemoglobin" } });

  // The share: the patient's visit code, redeemed by the doctor.
  const issued = await issueAccessCode(patientId, a.userId, "E2E smoke visit");
  const redeemed = await redeemAccessCode({ code: issued.code, doctorUserId: doctorUser.id, doctorStaffId: staff.id, doctorName, facilityId: PUNE });
  if (!redeemed) throw new Error("fixture share: the code was not redeemed");
  await drain();

  // Week 5a: a directory doctor, through the real services (register, verify, list, link, locate).
  const netName = `Dr. Network ${tag}`;
  const netUser = await prisma.user.create({ data: { email: `e2e-network-${tag}@verify.aarogya`, passwordHash: hash, role: "DOCTOR", displayName: netName } });
  const netStaff = await prisma.hospitalStaffProfile.create({ data: { userId: netUser.id, departmentId: dept.id, displayRole: "General physician" } });
  await ensurePrimaryMembership(prisma, netUser.id, PUNE, { isAdmin: false });
  const verifierUser = await prisma.user.create({ data: { email: `e2e-verifier-${tag}@verify.aarogya`, passwordHash: hash, role: "AAROGYA_ADMIN", displayName: "Smoke verifier" } });
  const adminUser = await prisma.user.create({ data: { email: `e2e-admin-${tag}@verify.aarogya`, passwordHash: hash, role: "HOSPITAL_ADMIN", displayName: "Smoke admin" } });
  await prisma.hospitalStaffProfile.create({ data: { userId: adminUser.id, departmentId: dept.id, displayRole: "Admin" } });
  await ensurePrimaryMembership(prisma, adminUser.id, PUNE, { isAdmin: true });
  const doc = await registerDoctor(netUser.id, { registrationNumber: `E2E${tag}`.toUpperCase(), stateCouncil: "MMC", registrationYear: 2008, specialties: ["GENERAL_MEDICINE"], languages: ["en", "hi"] });
  const vcase = await submitVerification(netUser.id, [{ bytes: Buffer.from("%PDF-1.4\n%%EOF\n"), contentType: "application/pdf", originalName: "registration.pdf" }]);
  await decideVerification(verifierUser.id, vcase.caseId, { decision: "APPROVE" });
  await updateOwnProfile(netUser.id, { listed: true });
  const link = await claimStaffProfile(netUser.id, PUNE);
  await decideStaffLink({ userId: adminUser.id, facilityId: PUNE }, link.id, true);
  const loc = await addHospitalLocation(netUser.id, { facilityId: PUNE, modes: ["IN_PERSON", "VIDEO"], lat: 18.5204, lng: 73.8567, pincode: "411001" });
  for (let dow = 0; dow < 7; dow++) await prisma.doctorScheduleBlock.create({ data: { staffId: netStaff.id, facilityId: PUNE, dayOfWeek: dow, startMinute: 0, endMinute: 1440, slotDurationMinutes: 15 } });
  await refreshNextSlot(loc.id);
  void doc;
  await drain();

  // Week 5c: the facility's own payment gateway, in test mode (the run's secrets are in the environment).
  const { setFacilityGateway } = await import("../../src/lib/insurance/hospitalPayments");
  await setFacilityGateway({ userId: adminUser.id, facilityId: PUNE }, { keyId: `rzp_test_e2e${tag}`.slice(0, 40), secretRef: E2E_GATEWAY_REF, mode: "TEST", enabled: true });

  mkdirSync(outDir, { recursive: true });
  const samplePdf = path.join(outDir, "sample-report.pdf");
  writeFileSync(samplePdf, await fixturePdf(fixtureById("lab-en-cbc")!));
  const fixture: E2eFixture = {
    tag, password, patient: { email, patientId, name, verifiedPhone }, doctor: { email: doctorUser.email, name: doctorName }, networkDoctor: { email: netUser.email, name: netName },
    desk: { email: adminUser.email }, appointmentId: appointment.id, gatewaySecretRef: E2E_GATEWAY_REF,
    shareId: redeemed.id, samplePdf, sampleTitle: `Blood count ${tag}`,
  };
  writeFileSync(path.join(outDir, "fixture.json"), JSON.stringify(fixture, null, 2));
  return fixture;
}
