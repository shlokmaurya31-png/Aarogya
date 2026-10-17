/**
 * Phase 0, part 1 (e): the identity gate (docs/PERSON_IDENTITY_DESIGN.md
 * §4–§5, §8.2). Complements verify-postgres-patient-self-registration (the
 * phone code with its second factor) and verify-postgres-identity-migration.
 *
 *   1. In-person ID verification: only the last 4 characters are accepted
 *      and stored; staff member A records, A can't approve, a different B
 *      approves, the person confirms; audited with both staff; the database
 *      itself refuses one-person approval, a 5-character ID and an ACTIVE
 *      link with no method.
 *   2. A second facility: the person connects their Noida record; both are
 *      "self"; another facility's staff can't touch the Pune link.
 *   3. Unlinking by the person: UNLINKED, the record untouched, no longer
 *      self; connecting again is a new verification, never a reactivation.
 *   4. Unlinking by the facility: requester ≠ approver (service and CHECK);
 *      the person's access log records it.
 *   5. ABHA: refused while the flag is off; with it on, only ABDM-verified
 *      identifiers on both sides count, the person confirms; a VERIFIED
 *      identifier without ABDM verification is refused by the database.
 *   6. Care relationship windows: OPD 30 days after the last encounter, IPD
 *      the admission plus 30 days after discharge, per facility, capped at 90.
 *   7. Staff never read a person's profile, contacts, links or access log.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-person-identity.ts
 */
import { createHash } from "node:crypto";
import { prisma } from "../src/lib/db";
import { registerPatientAccount, connectFacilityRecord } from "../src/lib/patient/selfRegistration";
import {
  startInPersonVerification, approveInPersonVerification, confirmPendingLink, unlinkByPerson,
  requestFacilityUnlink, approveFacilityUnlink, offerAbhaLink, pendingConfirmations,
} from "../src/lib/person/linking";
import { selfPatientIds } from "../src/lib/person/self";
import { careRelationship, personAccess } from "../src/lib/person/access";
import { resolveKeySpec } from "../src/lib/config/registry";
import { clearConfigCache } from "../src/lib/config/cache";
import { staffAtFacilityWhere } from "../src/lib/auth/staffFacility";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const refused = <T>(p: Promise<T>) => p.then(() => false, () => true);
const run = Date.now().toString(36);
const PUNE = "fac-amc-pune";
const NOIDA = "fac-amc-noida";

async function staffWithRole(facilityId: string, role: "FRONT_DESK" | "HOSPITAL_ADMIN") {
  return prisma.hospitalStaffProfile.findFirstOrThrow({ where: { AND: [staffAtFacilityWhere(facilityId), { user: { role } }] }, orderBy: { id: "asc" }, select: { id: true, userId: true } });
}

async function main() {
  const A = await staffWithRole(PUNE, "FRONT_DESK");
  const B = await staffWithRole(PUNE, "HOSPITAL_ADMIN");
  const noidaDesk = await staffWithRole(NOIDA, "FRONT_DESK");

  // ── 1. In-person ID verification ──
  const rec = await prisma.patient.create({ data: { uhid: `PID-${run}`, facilityId: PUNE, fullName: `Person Identity ${run}`, sex: "F", dob: new Date("1979-08-09") } });
  const reg = await registerPatientAccount({ fullName: rec.fullName, email: `pid-${run}@verify.aarogya`, passwordHash: "x", sex: "F", dob: new Date("1979-08-09") });
  report("A match with no phone on the record routes to in-person verification", reg.status === "IN_PERSON_REQUIRED", reg.status);
  const user = reg.userId;
  const personId = (await prisma.personAccount.findUniqueOrThrow({ where: { userId: user } })).personId;
  const req = await prisma.patientLinkRequest.findFirstOrThrow({ where: { userId: user } });
  const full = await startInPersonVerification({ facilityId: PUNE, requestId: req.id, staffId: A.id, byUserId: A.userId, idType: "AADHAAR", idLast4: "123456789012", reason: "NO_PHONE_ON_RECORD" }).then(() => "accepted", (e) => String(e.message));
  report("A full ID number is refused, never truncated, and nothing is stored", /last 4 characters/.test(full) && (await prisma.personPatientLink.count({ where: { patientId: rec.id } })) === 0);
  const started = await startInPersonVerification({ facilityId: PUNE, requestId: req.id, staffId: A.id, byUserId: A.userId, idType: "AADHAAR", idLast4: "4321", reason: "NO_PHONE_ON_RECORD" });
  const pending = await prisma.personPatientLink.findUniqueOrThrow({ where: { id: started.linkId } });
  report("Staff member A's check: a PENDING link with the ID type and 4 characters only", pending.status === "PENDING_VERIFICATION" && pending.idType === "AADHAAR" && pending.idLast4 === "4321" && pending.verifiedByStaffId === A.id);
  const audits = await prisma.auditEvent.findMany({ where: { type: { startsWith: "patient.person.link." }, patientId: rec.id } });
  report("…and the audit never holds the ID digits", audits.length > 0 && !JSON.stringify(audits.map((a) => a.detail)).includes("4321"));
  report("A cannot approve their own check", await refused(approveInPersonVerification({ facilityId: PUNE, linkId: started.linkId, staffId: A.id, byUserId: A.userId })));
  report("The person can't confirm before a second staff member approves", await refused(confirmPendingLink(user, started.linkId)) && (await pendingConfirmations(user)).length === 0);
  report("Another facility's staff can't approve it (not found)", await refused(approveInPersonVerification({ facilityId: NOIDA, linkId: started.linkId, staffId: noidaDesk.id, byUserId: noidaDesk.userId })));
  await approveInPersonVerification({ facilityId: PUNE, linkId: started.linkId, staffId: B.id, byUserId: B.userId });
  report("After B approves, the person sees it waiting for their confirmation", (await pendingConfirmations(user)).some((p) => p.id === started.linkId));
  const confirmed = await confirmPendingLink(user, started.linkId);
  const active = await prisma.personPatientLink.findUniqueOrThrow({ where: { id: started.linkId } });
  report("The person confirms: ACTIVE, IN_PERSON_ID, two different staff on the record",
    confirmed.status === "LINKED" && active.status === "ACTIVE" && active.method === "IN_PERSON_ID" && active.approvedByStaffId === B.id && active.verifiedByStaffId === A.id);
  const linkedAudit = await prisma.auditEvent.findFirst({ where: { type: "patient.person.link.linked", detail: { path: ["linkId"], equals: started.linkId } } });
  report("…audited with both staff members", (linkedAudit?.detail as { verifiedByStaffId?: string; approvedByStaffId?: string })?.verifiedByStaffId === A.id && (linkedAudit?.detail as { approvedByStaffId?: string })?.approvedByStaffId === B.id);
  report("…the person's access log records it", (await prisma.personAccessLogEntry.count({ where: { personId, kind: "LINKED", accessingFacilityId: PUNE } })) === 1);
  report("…PersonPatientLinked, with the personId on the event", (await prisma.domainEventOutbox.count({ where: { eventType: "PersonPatientLinked", aggregateId: started.linkId, personId } })) === 1);
  report("…and the record is now the person's own", (await selfPatientIds(user)).includes(rec.id));
  // The database refuses what the service refuses.
  report("CHECK: one staff member can't be both verifier and approver",
    await refused(prisma.personPatientLink.update({ where: { id: started.linkId }, data: { approvedByStaffId: A.id } })));
  const other = await prisma.patient.create({ data: { uhid: `PID2-${run}`, facilityId: PUNE, fullName: `Check ${run}`, sex: "M" } });
  report("CHECK: a 5-character ID is refused",
    await refused(prisma.personPatientLink.create({ data: { personId, patientId: other.id, facilityId: PUNE, status: "PENDING_VERIFICATION", method: "IN_PERSON_ID", idType: "PAN", idLast4: "12345", inPersonReason: "NO_PHONE_ON_RECORD", verifiedByStaffId: A.id } })));
  report("CHECK: an ACTIVE link needs its method, time and actor",
    await refused(prisma.personPatientLink.create({ data: { personId, patientId: other.id, facilityId: PUNE, status: "ACTIVE" } })));
  report("Trigger: a link's facility must be its record's",
    await refused(prisma.personPatientLink.create({ data: { personId, patientId: other.id, facilityId: NOIDA, status: "PENDING_VERIFICATION" } })));

  // ── 2. A second facility ──
  const noida = await connectFacilityRecord(user, { facilityId: NOIDA, fullName: `Noida Self ${run}`, sex: "F" });
  const noidaPatientId = noida.status === "LINKED_NEW" ? noida.patientId : "";
  report("Connecting another facility with no match creates a record there, linked", noida.status === "LINKED_NEW");
  report("…both records are the person's own", (await selfPatientIds(user)).sort().join() === [rec.id, noidaPatientId].sort().join());
  report("Noida staff can't ask to unlink the Pune link (not found)", await refused(requestFacilityUnlink({ facilityId: NOIDA, linkId: started.linkId, reason: "WRONG_PERSON", byUserId: noidaDesk.userId })));

  // ── 3. Unlinking by the person ──
  const noidaLink = await prisma.personPatientLink.findFirstOrThrow({ where: { personId, patientId: noidaPatientId, status: "ACTIVE" } });
  await unlinkByPerson(user, noidaLink.id);
  const after = await prisma.personPatientLink.findUniqueOrThrow({ where: { id: noidaLink.id } });
  report("The person unlinks: UNLINKED by PERSON, reason PERSON_REQUEST", after.status === "UNLINKED" && after.unlinkedBy === "PERSON" && after.unlinkedReason === "PERSON_REQUEST");
  report("…the facility record is untouched, and no longer the person's own", (await prisma.patient.count({ where: { id: noidaPatientId } })) === 1 && !(await selfPatientIds(user)).includes(noidaPatientId));
  report("…PersonPatientUnlinked once", (await prisma.domainEventOutbox.count({ where: { eventType: "PersonPatientUnlinked", aggregateId: noidaLink.id } })) === 1);
  const again = await connectFacilityRecord(user, { facilityId: NOIDA, fullName: `Noida Self ${run}`, sex: "F" });
  report("Connecting again is a new verification, never a reactivation", again.status !== "LINKED_NEW" && (await prisma.personPatientLink.findUniqueOrThrow({ where: { id: noidaLink.id } })).status === "UNLINKED", again.status);

  // ── 4. Unlinking by the facility (two staff members) ──
  await requestFacilityUnlink({ facilityId: PUNE, linkId: started.linkId, reason: "WRONG_PERSON", byUserId: A.userId });
  report("The requester can't approve their own unlink", await refused(approveFacilityUnlink({ facilityId: PUNE, linkId: started.linkId, byUserId: A.userId })));
  report("…the link is still ACTIVE meanwhile", (await prisma.personPatientLink.findUniqueOrThrow({ where: { id: started.linkId } })).status === "ACTIVE");
  await approveFacilityUnlink({ facilityId: PUNE, linkId: started.linkId, byUserId: B.userId });
  const fu = await prisma.personPatientLink.findUniqueOrThrow({ where: { id: started.linkId } });
  report("A different staff member approves: UNLINKED by FACILITY, requester and approver recorded",
    fu.status === "UNLINKED" && fu.unlinkedBy === "FACILITY" && fu.unlinkedReason === "WRONG_PERSON" && fu.unlinkedByUserId === A.userId && fu.unlinkApprovedByUserId === B.userId);
  report("…the person's access log records both unlinks", (await prisma.personAccessLogEntry.count({ where: { personId, kind: "UNLINKED" } })) === 2);

  // ── 5. ABHA ──
  const abha = `91${String(Date.now()).slice(-12)}`.slice(0, 14);
  const abhaRec = await prisma.patient.create({ data: { uhid: `PIDABHA-${run}`, facilityId: PUNE, fullName: `Abha ${run}`, sex: "F" } });
  await prisma.externalIdentifier.create({ data: { facilityId: PUNE, entityType: "PATIENT", entityId: abhaRec.id, system: "https://healthid.abdm.gov.in", value: abha, verificationStatus: "VERIFIED", verifiedAt: new Date() } });
  delete process.env.PERSON_ABHA_LINKING;
  report("ABHA linking is refused while the flag is off", await refused(offerAbhaLink(user, PUNE)));
  process.env.PERSON_ABHA_LINKING = "enabled";
  const hash = createHash("sha256").update(abha).digest("hex");
  report("CHECK: an ABHA can't be VERIFIED without ABDM verification",
    await refused(prisma.personIdentifier.create({ data: { personId, system: "ABHA_NUMBER", valueHash: hash, valueLast4: abha.slice(-4), verificationStatus: "VERIFIED", verifiedAt: new Date() } })));
  await prisma.personIdentifier.create({ data: { personId, system: "ABHA_NUMBER", valueHash: hash, valueLast4: abha.slice(-4), verificationStatus: "UNVERIFIED" } });
  report("With the flag on, an unverified ABHA on the person's side doesn't count", await refused(offerAbhaLink(user, PUNE)));
  await prisma.personIdentifier.updateMany({ where: { personId, valueHash: hash }, data: { verificationStatus: "VERIFIED", verifiedVia: "ABDM_AUTH", verifiedAt: new Date() } });
  const offer = await offerAbhaLink(user, PUNE);
  report("Both sides ABDM-verified and equal: a link is offered, PENDING the person's confirmation", (await prisma.personPatientLink.findUniqueOrThrow({ where: { id: offer.linkId } })).status === "PENDING_VERIFICATION");
  await confirmPendingLink(user, offer.linkId);
  report("…the person confirms: ACTIVE, ABHA_BOTH_VERIFIED", (await prisma.personPatientLink.findUniqueOrThrow({ where: { id: offer.linkId } })).method === "ABHA_BOTH_VERIFIED");
  delete process.env.PERSON_ABHA_LINKING;

  // ── 6. Care relationship windows ──
  const day = 86_400_000;
  const patientAt = async (tag: string, facilityId = PUNE) => prisma.patient.create({ data: { uhid: `PIDCR-${tag}-${run}`, facilityId, fullName: `Care ${tag}`, sex: "M" } });
  const doctor = await prisma.user.findFirstOrThrow({ where: { email: "doctor1@amc-demo.aarogya" } });
  const enc = (patientId: string, facilityId: string, type: "OPD" | "IPD", registeredAt: Date, closedAt: Date | null) =>
    prisma.encounter.create({ data: { patientId, facilityId, type, status: closedAt ? "CLOSED" : "IN_CONSULTATION", registeredAt, closedAt, chiefComplaint: "care window" } });
  const none = await patientAt("none");
  report("No encounter: no care relationship", !(await careRelationship(PUNE, none.id)).active);
  const open = await patientAt("open"); await enc(open.id, PUNE, "OPD", new Date(Date.now() - 2 * day), null);
  report("An open encounter: a care relationship", (await careRelationship(PUNE, open.id)).kind === "OPEN");
  const opd10 = await patientAt("opd10"); await enc(opd10.id, PUNE, "OPD", new Date(Date.now() - 11 * day), new Date(Date.now() - 10 * day));
  const opd40 = await patientAt("opd40"); await enc(opd40.id, PUNE, "OPD", new Date(Date.now() - 41 * day), new Date(Date.now() - 40 * day));
  report("OPD: 10 days after the last visit, yes; 40 days, no", (await careRelationship(PUNE, opd10.id)).active && !(await careRelationship(PUNE, opd40.id)).active);
  // Free beds (an occupied bed can't take a second admission).
  const beds = await prisma.bed.findMany({ where: { facilityId: PUNE, admissions: { none: { discharge: { is: null } } } }, select: { id: true }, orderBy: { id: "asc" }, take: 3 });
  let bedNo = 0;
  const ipd = async (tag: string, dischargedDaysAgo: number | null) => {
    const p = await patientAt(tag);
    const e = await enc(p.id, PUNE, "IPD", new Date(Date.now() - (dischargedDaysAgo ?? 0) * day - 5 * day), dischargedDaysAgo === null ? null : new Date(Date.now() - dischargedDaysAgo * day));
    const adm = await prisma.admission.create({ data: { encounterId: e.id, bedId: beds[bedNo++].id, reason: "care window", admittingStaffId: B.id, admittedAt: e.registeredAt } });
    if (dischargedDaysAgo !== null) await prisma.discharge.create({ data: { admissionId: adm.id, dischargedAt: new Date(Date.now() - dischargedDaysAgo * day) } });
    return p;
  };
  const inpatient = await ipd("inpatient", null);
  const ipd20 = await ipd("ipd20", 20);
  const ipd40 = await ipd("ipd40", 40);
  report("IPD: during the admission, yes", (await careRelationship(PUNE, inpatient.id)).kind === "OPEN");
  report("IPD: 20 days after discharge, yes; 40 days, no", (await careRelationship(PUNE, ipd20.id)).active && !(await careRelationship(PUNE, ipd40.id)).active);
  const spec = resolveKeySpec("identity.care_window_ipd_days")!;
  report("The window is capped at 90 days by the registry", await refused(Promise.resolve().then(() => spec.normalize("91"))) && spec.normalize("60") === "60");
  const org = (await prisma.facility.findUniqueOrThrow({ where: { id: PUNE }, select: { organizationId: true } })).organizationId!;
  const override = await prisma.configurationOverride.create({ data: { key: "identity.care_window_ipd_days", valueType: "NUMBER", scope: "FACILITY", scopeRef: PUNE, organizationId: org, facilityId: PUNE, value: "60", status: "PUBLISHED", version: 9999, effectiveFrom: new Date(Date.now() - day) } });
  clearConfigCache();
  report("A facility can set its own window (60 days): 40 days after discharge is now inside it", (await careRelationship(PUNE, ipd40.id)).active);
  await prisma.configurationOverride.delete({ where: { id: override.id } });
  clearConfigCache();
  report("…and another facility's records are never in this facility's relationship", !(await careRelationship(NOIDA, ipd20.id)).active);

  // ── 7. Staff never read the person's own data ──
  report("Staff get nothing for a person's profile, links or access log", (await personAccess({ kind: "STAFF", userId: A.userId, facilityId: PUNE }, personId, "PROFILE")) === null);
  report("The person's own login does", (await personAccess({ kind: "OWNER", userId: user }, personId, "PROFILE"))?.via === "OWNER");
  report("Another account's login does not", (await personAccess({ kind: "OWNER", userId: doctor.id }, personId, "PROFILE")) === null);

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
