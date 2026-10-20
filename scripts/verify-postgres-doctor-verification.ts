/**
 * Week 5a — verification first (docs/DOCTOR_NETWORK_DESIGN.md §4, §10):
 *   - registering: only a DOCTOR login, one profile per registration; starts
 *     UNVERIFIED and unlisted, with DoctorRegistered;
 *   - an unverified, pending or rejected doctor is absent from search and
 *     can't be booked; listing before verification is refused;
 *   - the platform team's case: 48-hour due date; the queue oldest-due first;
 *     approval confirms the registration year ("registered since"), with
 *     DoctorVerificationStatusChanged; the doctor appears only once listed;
 *   - a verifier can't verify themselves; rejection needs a closed reason;
 *   - documents: readable only by the doctor and the verifier (5-minute URL,
 *     audited), deleted 90 days after the decision while the decision stays;
 *   - suspension removes the doctor from search and new bookings at once, and
 *     their existing appointment stays.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-doctor-verification.ts
 */
import "./lib/gateBootstrap";
import { prisma } from "../src/lib/db";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { registerDoctor, updateOwnProfile } from "../src/lib/doctors/profile";
import { caseDocumentUrl, decideVerification, purgeVerificationDocuments, submitVerification, suspendDoctor, verificationQueue } from "../src/lib/doctors/verification";
import { searchDirectory } from "../src/lib/doctors/directory";
import { bookThroughDirectory } from "../src/lib/doctors/booking";
import { PUNE, drain, eventsOf, refused, reporter, sharer, notFound } from "./lib/shareFixture";
import { doctorLogin, facilityAdmin, networkDoctor, verifier } from "./lib/doctorFixture";

const { report, done } = reporter();
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const inSearch = async (doctorId: string) => (await searchDirectory({})).results.some((r) => r.doctorId === doctorId);

async function main() {
  registerAllConsumers();
  const v = await verifier();
  const admin = await facilityAdmin(PUNE);
  const login = await doctorLogin(PUNE, "Dr Pending Gate");
  const patient = await sharer();

  // 1. Registering.
  report("A patient login can't register a doctor profile", await refused(registerDoctor(patient.userId, { registrationNumber: "X1", stateCouncil: "MMC", specialties: ["CARDIOLOGY"] })));
  report("An unknown council or specialty is refused", await refused(registerDoctor(login.userId, { registrationNumber: "X1", stateCouncil: "ZZ", specialties: ["CARDIOLOGY"] })) && await refused(registerDoctor(login.userId, { registrationNumber: "X1", stateCouncil: "MMC", specialties: ["ASTROLOGY"] })));
  const d = await registerDoctor(login.userId, { registrationNumber: `ver-${Date.now()}`, stateCouncil: "MMC", registrationYear: 2012, specialties: ["CARDIOLOGY"], languages: ["en", "hi"] });
  report("Registering: UNVERIFIED, unlisted, with DoctorRegistered", d.verificationStatus === "UNVERIFIED" && !d.listed && (await eventsOf(d.id, "DoctorRegistered")).length === 1);
  const other = await doctorLogin(PUNE);
  report("The same registration can't be claimed twice", await refused(registerDoctor(other.userId, { registrationNumber: d.registrationNumber, stateCouncil: "MMC", specialties: ["CARDIOLOGY"] })));
  report("Listing before verification is refused", await refused(updateOwnProfile(login.userId, { listed: true })));
  report("An unverified doctor is absent from search", !(await inSearch(d.id)));

  // 2. The case.
  const c = await submitVerification(login.userId, [{ bytes: PDF, contentType: "application/pdf", originalName: "reg.pdf" }]);
  const pending = await prisma.doctorProfile.findUniqueOrThrow({ where: { id: d.id } });
  report("Submitting opens a case due in 48 hours; the doctor is PENDING, with its event",
    Math.abs(new Date(c.dueAt).getTime() - Date.now() - 48 * 3_600_000) < 60_000 && pending.verificationStatus === "PENDING" && (await eventsOf(d.id, "DoctorVerificationStatusChanged")).some((e) => (e.payload as { to?: string }).to === "PENDING"));
  report("A second open case is refused", await refused(submitVerification(login.userId, [{ bytes: PDF, contentType: "application/pdf", originalName: "again.pdf" }])));
  report("A pending doctor is absent from search", !(await inSearch(d.id)));
  const queue = await verificationQueue();
  report("The verifier's queue shows the case with the register details, oldest due first", queue.some((q) => q.id === c.caseId && q.doctor.registrationNumber === d.registrationNumber) && queue.every((q, i) => i === 0 || queue[i - 1].dueAt <= q.dueAt));
  report("The doctor reads their own document (5-minute URL)", !!(await caseDocumentUrl({ userId: login.userId, verifier: false }, c.caseId, 0)).url);
  report("Another doctor can't (404)", await notFound(caseDocumentUrl({ userId: other.userId, verifier: false }, c.caseId, 0)));
  report("…and the verifier's read is audited", !!(await caseDocumentUrl({ userId: v.id, verifier: true }, c.caseId, 0)).url && (await prisma.auditEvent.count({ where: { type: "doctor.verification.documentViewed", userId: v.id } })) === 1);
  report("Rejecting needs a closed reason code", await refused(decideVerification(v.id, c.caseId, { decision: "REJECT" })) && await refused(decideVerification(v.id, c.caseId, { decision: "REJECT", reasonCode: "free text" })));
  report("A verifier can't verify their own registration", await refused(decideVerification(login.userId, c.caseId, { decision: "APPROVE" })));
  await decideVerification(v.id, c.caseId, { decision: "APPROVE", registrationYear: 2011 });
  const verified = await prisma.doctorProfile.findUniqueOrThrow({ where: { id: d.id } });
  report("Approval: VERIFIED by document check, the register's year confirmed (2011), with its event",
    verified.verificationStatus === "VERIFIED" && verified.verificationMethod === "DOCUMENT_CHECK" && verified.registrationYear === 2011 && (await eventsOf(d.id, "DoctorVerificationStatusChanged")).some((e) => (e.payload as { to?: string }).to === "VERIFIED"));
  report("Verified but not yet listed: still absent from search", !(await inSearch(d.id)));

  // 3. Rejection.
  const rLogin = await doctorLogin(PUNE);
  const r = await registerDoctor(rLogin.userId, { registrationNumber: `rej-${Date.now()}`, stateCouncil: "KMC", specialties: ["DERMATOLOGY"] });
  const rc = await submitVerification(rLogin.userId, [{ bytes: PDF, contentType: "application/pdf", originalName: "reg.pdf" }]);
  await decideVerification(v.id, rc.caseId, { decision: "REJECT", reasonCode: "NOT_ON_REGISTER" });
  report("Rejection: REJECTED with its reason, absent from search, can't list", (await prisma.doctorProfile.findUniqueOrThrow({ where: { id: r.id } })).verificationStatus === "REJECTED" && !(await inSearch(r.id)) && await refused(updateOwnProfile(rLogin.userId, { listed: true })));

  // 4. A listed doctor, then suspended.
  const s = await networkDoctor(PUNE, v, admin, { specialties: ["ORTHOPAEDICS"], name: "Dr Suspend Gate" });
  await drain();
  report("A verified, listed doctor with a location is in search", await inSearch(s.doctorId));
  const slot = await prisma.doctorNextSlot.findUniqueOrThrow({ where: { practiceLocationId: s.locationId! } });
  const booked = await bookThroughDirectory(patient.userId, { locationId: s.locationId, start: slot.nextSlotAt!.toISOString() });
  await suspendDoctor(v.id, s.doctorId, "REGISTRATION_SUSPENDED");
  report("Suspension: out of search at once, unlisted, with its event", !(await inSearch(s.doctorId)) && !(await prisma.doctorProfile.findUniqueOrThrow({ where: { id: s.doctorId } })).listed && (await eventsOf(s.doctorId, "DoctorVerificationStatusChanged")).some((e) => (e.payload as { to?: string }).to === "SUSPENDED"));
  report("…new bookings refused (404)", await notFound(bookThroughDirectory(patient.userId, { locationId: s.locationId, start: new Date(slot.nextSlotAt!.getTime() + 15 * 60_000).toISOString() })));
  report("…the existing appointment stays", (await prisma.appointment.findUniqueOrThrow({ where: { id: booked.appointmentId } })).status !== "CANCELLED");

  // 5. Retention.
  await prisma.doctorVerificationCase.update({ where: { id: c.caseId }, data: { decidedAt: new Date(Date.now() - 91 * 86_400_000) } });
  const purged = await purgeVerificationDocuments();
  const after = await prisma.doctorVerificationCase.findUniqueOrThrow({ where: { id: c.caseId } });
  report("90 days after the decision the documents go, the decision stays", purged.purged >= 1 && after.documentRefs.length === 0 && !!after.documentsPurgedAt && after.status === "APPROVED" && (await eventsOf(c.caseId, "DoctorVerificationCaseChanged")).some((e) => (e.payload as { to?: string }).to === "DOCUMENTS_PURGED"));
  report("…and can no longer be read (404)", await notFound(caseDocumentUrl({ userId: v.id, verifier: true }, c.caseId, 0)));

  await done();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
