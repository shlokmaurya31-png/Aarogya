/**
 * Week 5b — households and proxy permissions (docs/HOUSEHOLD_DESIGN.md §4, §5, §7, §10):
 *   - a household: the manager's SELF profile, HouseholdCreated; at most 8 members;
 *   - adding a child: verifiable parental consent (a code to the manager's own
 *     verified phone + the relationship declaration); a wrong code or no
 *     declaration refuses; no date of birth refuses; the child's own Person
 *     (no login), a GUARDIAN grant with every permission, nothing sensitive;
 *   - membership alone gives nothing: another manager of the same household
 *     without a grant sees nothing (404);
 *   - each permission admits exactly its actions: VIEW without BOOK can't
 *     book; UPLOAD uploads to the member's Person (as the proxy); SHARE never
 *     exceeds what the proxy can see; INSURANCE; every proxy action is in the
 *     member's access log (via PROXY);
 *   - facts confirmed by a proxy are labelled "confirmed by proxy";
 *   - a dependent adult's proxy waits for the adult's consent: their own
 *     code (not the manager's contact), two different staff of one facility
 *     in person, or a staff-reviewed legal document; until then nothing;
 *   - a linked adult accepts with their own choice and can remove the proxy at once;
 *   - every change emits its event.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-household-proxies.ts
 */
import "./lib/gateBootstrap";
process.env.SMS_PROVIDER = "outbox";
process.env.EMAIL_PROVIDER = "outbox";
import { prisma } from "../src/lib/db";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { acceptInvitation, addDependentAdult, confirmAddMinor, inviteLinkedAdult, startAddMinor } from "../src/lib/household/households";
import { confirmOwnCode, reviewLegalDocument, sendOwnCode, staffInPersonCheck, submitLegalDocument } from "../src/lib/household/dependentConsent";
import { bookForMember, insuranceForMember, issueCodeForMember, uploadForMember, viewMember } from "../src/lib/household/proxy";
import { grantsAboutMe, proxyProfiles, revokeGrantAsMember, updateGrantAsMember } from "../src/lib/household/grants";
import { bulkReview, listFactsFor } from "../src/lib/documents/review";
import { fixtureById, fixturePdf } from "../src/lib/documents/fixtures";
import { setDocumentProvidersForTest } from "../src/lib/ai/documents";
import { PUNE, drain, eventsOf, lab, notFound, refused, reporter, sharer, staff, tag } from "./lib/shareFixture";
import { child, lastSmsCode, manager, verifiedPhone } from "./lib/householdFixture";

const { report, done } = reporter();

async function main() {
  registerAllConsumers();
  setDocumentProvidersForTest(null);
  const M = await manager();
  report("A household: the manager's own profile (SELF, MANAGER), with HouseholdCreated", (await prisma.householdMember.count({ where: { householdId: M.householdId, personId: M.personId, memberType: "SELF", role: "MANAGER", status: "ACTIVE" } })) === 1 && (await eventsOf(M.householdId, "HouseholdCreated")).length === 1);

  // 1. Adding a child.
  const dob = new Date(Date.now() - 6 * 365 * 86_400_000).toISOString().slice(0, 10);
  report("No declaration: refused", await refused(startAddMinor(M.userId, M.householdId, { displayName: "X", dateOfBirth: dob, relationship: "MOTHER" })));
  report("No full date of birth: refused (a profile with no date of birth can't be a managed child)", await refused(startAddMinor(M.userId, M.householdId, { displayName: "X", dateOfBirth: "2019", relationship: "MOTHER", declaration: true })));
  const noPhone = await sharer();
  const { createHousehold } = await import("../src/lib/household/households");
  const h2 = await createHousehold(noPhone.userId, "No phone");
  report("A manager without a verified phone can't add a child (the consent code goes to it)", await refused(startAddMinor(noPhone.userId, h2.id, { displayName: "X", dateOfBirth: dob, relationship: "FATHER", declaration: true })));
  const s = await startAddMinor(M.userId, M.householdId, { displayName: `Asha ${tag}`, dateOfBirth: dob, relationship: "MOTHER", declaration: true });
  report("The code goes to the manager's own phone (masked in the answer)", s.sentTo.endsWith(M.phone.slice(-4)) && !s.sentTo.includes(M.phone.slice(0, 6)));
  report("A wrong code is refused", await refused(confirmAddMinor(M.userId, s.consentId, "000000")));
  const c = await confirmAddMinor(M.userId, s.consentId, lastSmsCode(M.phone));
  await prisma.person.update({ where: { id: c.childPersonId }, data: { dataClassification: "SYNTHETIC" } });
  const kid = await prisma.person.findUniqueOrThrow({ where: { id: c.childPersonId }, include: { accounts: true } });
  const g = await prisma.proxyGrant.findUniqueOrThrow({ where: { id: c.grantId } });
  report("The child is their own Person, with no login", kid.managedByHousehold && kid.accounts.length === 0 && kid.dobPrecision === "DAY");
  report("The manager holds a GUARDIAN grant: every permission, the default categories, nothing sensitive", g.basis === "GUARDIAN" && g.permissions.length === 6 && g.categories.includes("UPLOADS") && !g.categories.includes("CLINICAL_NOTES") && g.sensitiveCategories.length === 0);
  report("…with ProxyGrantChanged and HouseholdMemberStatusChanged, and the consent recorded with its declaration",
    (await eventsOf(g.id, "ProxyGrantChanged")).length === 1 && (await eventsOf(c.memberId, "HouseholdMemberStatusChanged")).length === 1 && !!(await prisma.parentalConsent.findUniqueOrThrow({ where: { id: s.consentId } })).confirmedAt);
  report("The profile switcher lists the child for the manager", (await proxyProfiles(M.userId)).some((p) => p.personId === c.childPersonId));

  // 2. Membership gives nothing.
  const co = await sharer();
  const coPerson = co.personId;
  await prisma.householdMember.create({ data: { householdId: M.householdId, personId: coPerson, memberType: "LINKED_ADULT", role: "MANAGER", status: "ACTIVE", joinedAt: new Date() } });
  report("A second manager of the same household, without a grant, sees nothing of the child (404)", await notFound(viewMember(co.userId, c.childPersonId)));
  report("…and isn't offered the child in the switcher", !(await proxyProfiles(co.userId)).some((p) => p.personId === c.childPersonId));

  // 3. Each permission.
  const childDoc = await uploadForMember(M.userId, c.childPersonId, { bytes: await fixturePdf(fixtureById("lab-en-cbc")!), contentType: "application/pdf", originalName: "cbc.pdf", title: `Child CBC ${tag}`, type: "REPORT" });
  report("UPLOAD: the document is the child's, uploaded by the manager", childDoc.personId === c.childPersonId && childDoc.uploadedByUserId === M.userId);
  await drain();
  const facts = await listFactsFor(M.userId, c.childPersonId, {});
  report("UPLOAD includes reviewing the child's extracted facts", facts.length > 0);
  await bulkReview(M.userId, { decisions: facts.filter((f) => f.bulkConfirmable).map((f) => ({ factId: f.id, version: f.version, decision: "CONFIRM" })), memberPersonId: c.childPersonId });
  await drain();
  const entries = await prisma.patientProvidedRecord.findMany({ where: { personId: c.childPersonId, status: "ACTIVE" } });
  report("Facts the proxy confirmed are the child's entries, labelled confirmed by proxy", entries.length > 0 && entries.every((e) => e.confirmedByProxy));
  const view = await viewMember(M.userId, c.childPersonId);
  report("VIEW: the child's uploads show to the guardian", JSON.stringify(view).includes(`Child CBC ${tag}`));
  report("Every proxy action is in the child's access log, via PROXY with the manager's Person",
    (await prisma.personAccessLogEntry.count({ where: { personId: c.childPersonId, kind: "PROXY_ACTION", actorUserId: M.userId, AND: [{ detail: { path: ["via"], equals: "PROXY" } }, { detail: { path: ["proxyPersonId"], equals: M.personId } }] } })) >= 2);
  report("INSURANCE: the child's coverage reads (no records yet: empty)", Array.isArray((await insuranceForMember(M.userId, c.childPersonId)).records));

  // A viewer-only proxy (an aunt, a linked adult with her own login, given VIEW by the guardian).
  const aunt = await sharer();
  await prisma.proxyGrant.create({ data: { memberPersonId: c.childPersonId, proxyPersonId: aunt.personId, householdId: M.householdId, basis: "GUARDIAN", permissions: ["VIEW"], categories: ["LABS"], status: "ACTIVE", grantedByPersonId: M.personId } });
  report("VIEW without BOOK can't book (404)", await notFound(bookForMember(aunt.userId, c.childPersonId, { locationId: "x", start: new Date().toISOString() })));
  report("VIEW without UPLOAD can't upload (404)", await notFound(uploadForMember(aunt.userId, c.childPersonId, { bytes: Buffer.from("%PDF-1.4\n%%EOF\n"), contentType: "application/pdf", originalName: "x.pdf", title: "x", type: "REPORT" })));
  report("VIEW without SHARE can't share (404)", await notFound(issueCodeForMember(aunt.userId, c.childPersonId, { categories: ["LABS"] })));
  report("VIEW with only LABS: the uploads aren't in her view", !JSON.stringify(await viewMember(aunt.userId, c.childPersonId)).includes(`Child CBC ${tag}`));

  // SHARE never exceeds VIEW.
  const kidRecord = await prisma.patient.create({ data: { uhid: `HH-${tag}`, facilityId: PUNE, fullName: `Asha ${tag}`, sex: "F" } });
  await prisma.personPatientLink.create({ data: { personId: c.childPersonId, patientId: kidRecord.id, facilityId: PUNE, status: "ACTIVE", method: "SELF_CREATED", linkedAt: new Date(), linkedByUserId: M.userId } });
  await prisma.proxyGrant.update({ where: { id: g.id }, data: { categories: ["LABS", "UPLOADS"] } });
  report("SHARE can't share more than the proxy sees (PRESCRIPTIONS outside the grant)", await refused(issueCodeForMember(M.userId, c.childPersonId, { categories: ["PRESCRIPTIONS"] })));
  report("SHARE can't add a sensitive category the proxy can't see", await refused(issueCodeForMember(M.userId, c.childPersonId, { categories: ["LABS"], sensitiveCategories: ["HIV"] })));
  const shared = await issueCodeForMember(M.userId, c.childPersonId, { categories: ["LABS"] });
  report("…within it, the code is issued for the child's record", !!shared.code && !!shared.session.shareId);

  // 4. A dependent adult.
  const dep = await addDependentAdult(M.userId, M.householdId, { displayName: `Grandpa ${tag}`, dateOfBirth: "1945-04-04", relationship: "PARENT", permissions: ["VIEW", "BOOK"], phone: `+9196${String(Date.now()).slice(-8)}` });
  report("A dependent adult: membership PENDING_CONSENT, grant PENDING_CONFIRMATION", (await prisma.proxyGrant.findUniqueOrThrow({ where: { id: dep.grantId } })).status === "PENDING_CONFIRMATION" && (await prisma.householdMember.findUniqueOrThrow({ where: { id: dep.memberId } })).status === "PENDING_CONSENT");
  report("…and until the adult consents, the manager sees nothing (404)", await notFound(viewMember(M.userId, dep.adultPersonId)));
  const own = await sendOwnCode(M.userId, M.householdId, dep.adultPersonId);
  const depPhone = (await prisma.personContact.findFirstOrThrow({ where: { personId: dep.adultPersonId } })).value;
  report("OWN_CODE: a wrong code refuses", await refused(confirmOwnCode(M.userId, own.consentId, "999999")));
  await confirmOwnCode(M.userId, own.consentId, lastSmsCode(depPhone));
  report("OWN_CODE: the adult's own code activates the grant and the membership, with events",
    (await prisma.proxyGrant.findUniqueOrThrow({ where: { id: dep.grantId } })).status === "ACTIVE" && (await prisma.householdMember.findUniqueOrThrow({ where: { id: dep.memberId } })).status === "ACTIVE" && (await eventsOf(own.consentId, "DependentConsentChanged")).length === 2);
  report("A dependent adult's contact can't be the manager's own (their consent code would reach the manager)", await refused(addDependentAdult(M.userId, M.householdId, { displayName: `Grandma ${tag}`, dateOfBirth: "1948-05-05", relationship: "PARENT", phone: M.phone })));
  const dep2 = await addDependentAdult(M.userId, M.householdId, { displayName: `Grandma ${tag}`, dateOfBirth: "1948-05-05", relationship: "PARENT" });
  report("…and without a contact of their own, OWN_CODE can't be used", await refused(sendOwnCode(M.userId, M.householdId, dep2.adultPersonId)));
  const s1 = await staff(PUNE, "NURSE"), s2 = await staff(PUNE, "DOCTOR");
  await staffInPersonCheck({ userId: s1.userId, staffId: s1.staffId, facilityId: PUNE }, dep2.adultPersonId, M.personId);
  report("TWO_STAFF: the same staff member can't make the second check", await refused(staffInPersonCheck({ userId: s1.userId, staffId: s1.staffId, facilityId: PUNE }, dep2.adultPersonId, M.personId)));
  report("…one check alone leaves it pending", (await prisma.proxyGrant.findUniqueOrThrow({ where: { id: dep2.grantId } })).status === "PENDING_CONFIRMATION");
  await staffInPersonCheck({ userId: s2.userId, staffId: s2.staffId, facilityId: PUNE }, dep2.adultPersonId, M.personId);
  report("TWO_STAFF: a second, different staff member confirms: ACTIVE", (await prisma.proxyGrant.findUniqueOrThrow({ where: { id: dep2.grantId } })).status === "ACTIVE");
  const dep3 = await addDependentAdult(M.userId, M.householdId, { displayName: `Uncle ${tag}`, relationship: "OTHER_RELATIVE" });
  const poa = await prisma.personDocument.create({ data: { personId: dep3.adultPersonId, type: "OTHER", title: "Power of attorney", storageRef: `patient-uploads/${dep3.adultPersonId}/00000000000000aa-poa.pdf`, sha256: "3".repeat(64), uploadedByUserId: M.userId } });
  const lc = await submitLegalDocument(M.userId, M.householdId, dep3.adultPersonId, poa.id, "POWER_OF_ATTORNEY");
  await reviewLegalDocument({ userId: s1.userId, staffId: s1.staffId, facilityId: PUNE }, lc.consentId, true);
  report("LEGAL_DOCUMENT: a staff member's review of a power of attorney activates it", (await prisma.proxyGrant.findUniqueOrThrow({ where: { id: dep3.grantId } })).status === "ACTIVE");

  // 5. A linked adult.
  const spouse = await sharer();
  const spouseEmail = (await prisma.user.findUniqueOrThrow({ where: { id: spouse.userId }, select: { email: true } })).email;
  await lab(spouse.pune, spouse.punEnc, "Vitamin D", `18 sp${tag}`);
  await drain();
  await inviteLinkedAdult(M.userId, M.householdId, spouseEmail);
  const inv = await prisma.householdMember.findFirstOrThrow({ where: { householdId: M.householdId, personId: spouse.personId, status: "INVITED" } });
  report("An invited adult: nothing visible before they accept (404)", await notFound(viewMember(M.userId, spouse.personId)));
  await acceptInvitation(spouse.userId, inv.id, { permissions: ["VIEW"], categories: ["LABS"] });
  report("Accepting with their own choice: the manager sees their labs", JSON.stringify(await viewMember(M.userId, spouse.personId)).includes(`sp${tag}`));
  const about = await grantsAboutMe(spouse.userId);
  report("The adult sees who their proxies are", about.length >= 1 && about.every((x) => x.basis === "MEMBER_CHOICE"));
  await updateGrantAsMember(spouse.userId, about[0].id, { categories: ["PRESCRIPTIONS"] });
  report("…can narrow it (labs no longer shown)", !JSON.stringify(await viewMember(M.userId, spouse.personId)).includes(`sp${tag}`));
  await revokeGrantAsMember(spouse.userId, about[0].id);
  report("…and remove it: nothing at once (404)", await notFound(viewMember(M.userId, spouse.personId)));
  report("Someone else can't remove the adult's proxy (404)", await notFound(revokeGrantAsMember(M.userId, about[0].id)));

  // 6. The limit.
  const L = await manager();
  for (let i = 0; i < 7; i++) await child(L, 3 + i);
  report("The 8-member limit: the ninth is refused", await refused(startAddMinor(L.userId, L.householdId, { displayName: "Ninth", dateOfBirth: dob, relationship: "MOTHER", declaration: true })));
  void verifiedPhone;
  await done();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
