/**
 * 5b follow-up — a doctor's own record (docs/DOCTOR_NETWORK_DESIGN.md §14):
 *   - a work login verifies its phones by a code sent to them (a wrong code
 *     verifies nothing; a patient login can't add one; a phone verified on
 *     another login is refused);
 *   - the same-human check matches a verified work phone against the
 *     person's verified phones, however the number was written, as well as
 *     the login email: before the match the doctor opens the share (control),
 *     after it the share, the AI and the upload are refused (404) and the
 *     doctor can't be booked by their own patient login; a removed phone
 *     still counts;
 *   - reading their own chart at their own facility as staff is allowed but
 *     recorded: security.selfAccess (SELF_ACCESS, the surface, the facility and
 *     the record), and listed in the facility's self-access report for admins
 *     only (selfaccess.review); another staff member's read, or the doctor's
 *     read of another patient, records nothing; the four chart read routes
 *     call the recorder.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-doctor-self-access.ts
 */
import "./lib/gateBootstrap";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
process.env.SMS_PROVIDER = "outbox";
import { prisma } from "../src/lib/db";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { bookThroughDirectory } from "../src/lib/doctors/booking";
import { locationSlots } from "../src/lib/doctors/directory";
import { viewSharedRecord } from "../src/lib/sharing/view";
import { askAi, AskError } from "../src/lib/rag/ask";
import { personDocumentDownload } from "../src/lib/person/documents";
import { confirmLoginPhone, removeLoginPhone, startLoginPhone, listLoginPhones } from "../src/lib/auth/loginPhones";
import { isSameHuman, noteStaffChartRead, selfAccessReport } from "../src/lib/doctors/self";
import { authorizeAccess } from "../src/lib/auth/authorize/engine";
import { PUNE, NOIDA, drain, notFound, refused, reporter, sharer, staff, tag, upload } from "./lib/shareFixture";
import { facilityAdmin, networkDoctor, verifier } from "./lib/doctorFixture";
import { lastSmsCode } from "./lib/householdFixture";

const { report, done } = reporter();
process.env.AI_TEXT_KEY_VERSION = "1";
process.env.AI_TEXT_KEY_1 = randomBytes(32).toString("base64");

async function main() {
  registerAllConsumers();
  const v = await verifier();
  const admin = await facilityAdmin(PUNE);
  const doc = await networkDoctor(PUNE, v, admin, { name: `Dr Self ${tag}`, specialties: ["GENERAL_MEDICINE"] });
  const P = await sharer();
  const digits = `9${String(Date.now()).slice(-9)}`;
  const personPhone = `+91${digits}`;
  await prisma.personContact.create({ data: { personId: P.personId, kind: "PHONE", value: personPhone, verifiedAt: new Date() } });
  const up = await upload(P.personId, `Self upload ${tag}`);
  await drain();
  const actor = { userId: doc.userId, facilityId: PUNE, role: "DOCTOR" as const };

  // 1. Verifying a work phone.
  report("A patient login can't add a work phone (404)", await notFound(startLoginPhone(P.userId, "9876543210")));
  report("An invalid number is refused", await refused(startLoginPhone(doc.userId, "12345")));
  const s1 = await startLoginPhone(doc.userId, `${digits.slice(0, 5)} ${digits.slice(5)}`);
  report("The code is sent to the phone (masked in the reply)", s1.sentTo.endsWith(digits.slice(-4)) && !s1.sentTo.includes(digits.slice(0, 6)));
  report("A wrong code verifies nothing", await refused(confirmLoginPhone(doc.userId, s1.phoneId, "000000")) && (await listLoginPhones(doc.userId)).length === 0);
  report("Someone else can't confirm it (404)", await notFound(confirmLoginPhone(admin.userId, s1.phoneId, lastSmsCode(personPhone))));

  // 2. Before the match: the doctor opens a booking share (control).
  const day = (await prisma.doctorNextSlot.findUniqueOrThrow({ where: { practiceLocationId: doc.locationId! } })).nextSlotAt!;
  const [slot1, slot2] = await locationSlots(doc.locationId!, day);
  const b = await bookThroughDirectory(P.userId, { locationId: doc.locationId, start: slot1.start, share: { categories: ["LABS", "UPLOADS"] } });
  await prisma.recordShare.update({ where: { id: b.shareId! }, data: { validFrom: new Date(Date.now() - 60_000) } });
  report("Control: before the phone is verified, not the same human, and the share opens", !(await isSameHuman(doc, P.personId)) && !!(await viewSharedRecord(actor, b.shareId!, "SHARED_RECORD_VIEW")));
  const askBrief = async () => askAi({ kind: "STAFF", ...actor }, { mode: "VISIT_BRIEF", patientId: (await prisma.appointment.findUniqueOrThrow({ where: { id: b.appointmentId } })).patientId, shareId: b.shareId! }).then(() => "answered", (e) => (e instanceof AskError ? `refused ${e.status}` : `error ${e}`));
  report("Control: …and the AI answers through it", (await askBrief()) === "answered");

  // 3. The phone verified (written differently): the same human.
  await confirmLoginPhone(doc.userId, s1.phoneId, lastSmsCode(personPhone));
  report("Verified; listed masked", (await listLoginPhones(doc.userId)).length === 1 && !(await listLoginPhones(doc.userId))[0].phone.includes(digits.slice(0, 6)));
  report("The work phone matches the person's verified phone however it was written", await isSameHuman(doc, P.personId));
  report("The share now never opens through doctor tools (404)", await notFound(viewSharedRecord(actor, b.shareId!, "SHARED_RECORD_VIEW")));
  report("…nor the AI (404)", (await askBrief()) === "refused 404");
  report("…nor the upload (404)", await notFound(personDocumentDownload({ kind: "SHARE", userId: doc.userId, facilityId: PUNE, role: "DOCTOR", shareRef: b.shareId! }, up)));
  report("The doctor's own patient login can't book them", await refused(bookThroughDirectory(P.userId, { locationId: doc.locationId, start: slot2.start })));
  const other = await facilityAdmin(NOIDA);
  report("The same phone can't be verified on another login", await refused(startLoginPhone(other.userId, personPhone)));
  await removeLoginPhone(doc.userId, s1.phoneId);
  report("A removed phone still counts (removing it doesn't reopen the record)", (await listLoginPhones(doc.userId)).length === 0 && await isSameHuman(doc, P.personId));
  const unrelated = await sharer();
  report("Control: another person is not the doctor", !(await isSameHuman(doc, unrelated.personId)));

  // 4. Their own chart at their own facility, as staff.
  const before = await prisma.auditEvent.count({ where: { type: "security.selfAccess" } });
  const self = await noteStaffChartRead({ userId: doc.userId, facilityId: PUNE }, P.pune, "CHART");
  const row = await prisma.auditEvent.findFirst({ where: { type: "security.selfAccess", userId: doc.userId }, orderBy: { createdAt: "desc" } });
  report("Reading their own chart as staff is allowed and recorded as SELF_ACCESS (surface, facility, record)",
    self && (row?.detail as { accessKind?: string; surface?: string })?.accessKind === "SELF_ACCESS" && (row?.detail as { surface?: string }).surface === "CHART" && row?.facilityId === PUNE && row?.patientId === P.pune);
  const nurse = await staff(PUNE, "NURSE");
  report("Another staff member's read of the chart records nothing", !(await noteStaffChartRead({ userId: nurse.userId, facilityId: PUNE }, P.pune, "CHART")));
  report("The doctor's read of another patient records nothing", !(await noteStaffChartRead({ userId: doc.userId, facilityId: PUNE }, unrelated.pune, "SUMMARY")));
  report("…exactly one self-access row so far", (await prisma.auditEvent.count({ where: { type: "security.selfAccess" } })) === before + 1);
  await noteStaffChartRead({ userId: doc.userId, facilityId: PUNE }, P.pune, "TIMELINE");
  const rep = await selfAccessReport(PUNE);
  report("The facility's self-access report lists the doctor (2 reads), the record and the surfaces",
    rep.byStaff.some((x) => x.userId === doc.userId && x.count === 2) && rep.entries.filter((e) => e.userId === doc.userId).map((e) => e.surface).sort().join() === "CHART,TIMELINE" && rep.entries.some((e) => e.uhid !== null));
  report("…another facility's report doesn't", !(await selfAccessReport(NOIDA)).entries.some((e) => e.userId === doc.userId));
  const actorOf = async (userId: string, facilityId: string) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { hospitalStaffProfile: true } });
    return { userId, role: u.role, staffId: u.hospitalStaffProfile?.id ?? null, staffStatus: u.hospitalStaffProfile?.status ?? null, facilityId, authAgeMs: 1_000 };
  };
  const allowAdmin = await authorizeAccess({ actor: await actorOf(admin.userId, PUNE), action: "selfaccess.review", resource: { type: "SECURITY", facilityId: PUNE } }, { skipAudit: true });
  const denyDoc = await authorizeAccess({ actor: await actorOf(doc.userId, PUNE), action: "selfaccess.review", resource: { type: "SECURITY", facilityId: PUNE } }, { skipAudit: true });
  const denyOther = await authorizeAccess({ actor: await actorOf(other.userId, NOIDA), action: "selfaccess.review", resource: { type: "SECURITY", facilityId: PUNE } }, { skipAudit: true });
  report("Only the facility's admins may read the report (the doctor and another facility's admin are refused)", allowAdmin.decision === "ALLOW" && denyDoc.decision !== "ALLOW" && denyOther.decision !== "ALLOW");
  const routes = ["route.ts", "chart/route.ts", "summary/route.ts", "timeline/route.ts"].map((f) => readFileSync(`src/app/api/hospital/patients/[id]/${f}`, "utf8"));
  report("The four chart read routes record self-access", routes.every((src) => /await noteStaffChartRead\(\{ userId: session\.userId, facilityId \}, patient\.id, "(PATIENT|CHART|SUMMARY|TIMELINE)"\)/.test(src)));

  await done();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
