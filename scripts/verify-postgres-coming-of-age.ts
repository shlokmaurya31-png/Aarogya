/**
 * Week 5b — coming of age and claiming (docs/HOUSEHOLD_DESIGN.md §6, §10):
 *   - 30 days before the 18th birthday the managers are told (once);
 *   - on the birthday (a clock at it): every GUARDIAN grant lapses
 *     (CAME_OF_AGE), the guardian-given consents lapse, MemberCameOfAge; the
 *     manager then sees nothing (404);
 *   - a YEAR-precision date of birth comes of age on the next 1 January;
 *   - claiming with a code to the member's own contact (never the manager's)
 *     creates their own login; claiming without a phone or email is in person
 *     (a staff member checks ID and hands over the code);
 *   - after claiming, the member restores only the grants they choose
 *     (MEMBER_CHOICE); nothing is restored by itself;
 *   - a dependent adult can take control back the same way: their recorded-
 *     consent grants lapse (MEMBER_CLAIMED).
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-coming-of-age.ts
 */
import "./lib/gateBootstrap";
process.env.SMS_PROVIDER = "outbox";
process.env.EMAIL_PROVIDER = "outbox";
import { prisma } from "../src/lib/db";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { completeClaim, restoreGrant, startClaimInPerson, startClaimOwnContact, sweepComingOfAge } from "../src/lib/household/comingOfAge";
import { viewMember } from "../src/lib/household/proxy";
import { comingOfAge } from "../src/lib/household/vocab";
import { sweepConsentLapses } from "../src/lib/person/consentLapse";
import { PUNE, eventsOf, notFound, refused, reporter, staff, tag } from "./lib/shareFixture";
import { child, lastSmsCode, manager } from "./lib/householdFixture";

const { report, done } = reporter();

async function main() {
  registerAllConsumers();
  const M = await manager();
  const teen = await child(M, 17, `Teen ${tag}`);
  const teenDob = (await prisma.person.findUniqueOrThrow({ where: { id: teen.childPersonId } })).dateOfBirth!;
  // A guardian-given consent, as a parent decides for a child.
  await prisma.personConsent.create({ data: { personId: teen.childPersonId, purpose: "AI_ASSISTANCE", decision: "GRANTED", decidedByUserId: M.userId, decidedAt: new Date() } });
  report("Before: the guardian sees the teen's record", !!(await viewMember(M.userId, teen.childPersonId)));

  // 1. The notice, 30 days before.
  const eighteen = comingOfAge(teenDob, "DAY");
  const notice = await sweepComingOfAge({ now: new Date(eighteen.getTime() - 20 * 86_400_000) });
  await sweepComingOfAge({ now: new Date(eighteen.getTime() - 19 * 86_400_000) });
  report("30 days before: the manager is told once", notice.noticed >= 1 && (await prisma.personNotification.count({ where: { personId: M.personId, kind: "COMING_OF_AGE" } })) === 1);

  // 2. The birthday.
  const r = await sweepComingOfAge({ now: new Date(eighteen.getTime() + 60_000) });
  await sweepConsentLapses({ now: new Date(eighteen.getTime() + 60_000) });
  const g = await prisma.proxyGrant.findUniqueOrThrow({ where: { id: teen.grantId } });
  report("On the 18th birthday the GUARDIAN grant lapses (CAME_OF_AGE), with its event", r.cameOfAge >= 1 && g.status === "LAPSED" && g.lapsedReason === "CAME_OF_AGE" && (await eventsOf(g.id, "ProxyGrantChanged")).some((e) => (e.payload as { to?: string }).to === "LAPSED"));
  report("…MemberCameOfAge, and the member awaits a claim", (await eventsOf(teen.childPersonId, "MemberCameOfAge")).length === 1 && (await prisma.householdMember.findUniqueOrThrow({ where: { id: teen.memberId } })).status === "AWAITING_CLAIM");
  report("…the guardian's consent lapses too", (await prisma.personConsent.findFirstOrThrow({ where: { personId: teen.childPersonId, purpose: "AI_ASSISTANCE" } })).status === "LAPSED");
  report("…and the manager now sees nothing (404)", await notFound(viewMember(M.userId, teen.childPersonId)));
  report("A second run changes nothing", (await sweepComingOfAge({ now: new Date(eighteen.getTime() + 120_000) })).cameOfAge === 0);

  // 3. YEAR precision.
  const yr = await child(M, 10);
  await prisma.person.update({ where: { id: yr.childPersonId }, data: { dateOfBirth: new Date(Date.UTC(2008, 0, 1)), dobPrecision: "YEAR" } });
  const jan = comingOfAge(new Date(Date.UTC(2008, 0, 1)), "YEAR");
  report("A YEAR-precision date comes of age on the next 1 January", jan.toISOString().startsWith("2027-01-01"));
  await sweepComingOfAge({ now: new Date(Date.UTC(2026, 11, 31, 12)) });
  report("…still a guardian's on 31 December", (await prisma.proxyGrant.findUniqueOrThrow({ where: { id: yr.grantId } })).status === "ACTIVE");
  await sweepComingOfAge({ now: new Date(Date.UTC(2027, 0, 1, 0, 5)) });
  report("…lapsed on 1 January", (await prisma.proxyGrant.findUniqueOrThrow({ where: { id: yr.grantId } })).status === "LAPSED");

  // 4. Claiming with their own contact.
  report("Without their own verified contact, the claim is in person (refused by code)", await refused(startClaimOwnContact(M.userId, M.householdId, teen.childPersonId)));
  report("The manager's own phone can't be the member's contact (a contact belongs to one person), so the claim code never reaches the manager",
    await refused(prisma.personContact.create({ data: { personId: teen.childPersonId, kind: "PHONE", value: M.phone, verifiedAt: new Date() } })));
  const teenPhone = `+9195${String(Date.now()).slice(-8)}`;
  await prisma.personContact.create({ data: { personId: teen.childPersonId, kind: "PHONE", value: teenPhone, verifiedAt: new Date() } });
  const claim = await startClaimOwnContact(M.userId, M.householdId, teen.childPersonId);
  report("A wrong code can't claim", await refused(completeClaim(claim.claimId, "000000", { email: `teen-${tag}@verify.aarogya`, password: "a-long-password-1" })));
  const claimed = await completeClaim(claim.claimId, lastSmsCode(teenPhone), { email: `teen-${tag}@verify.aarogya`, password: "a-long-password-1" });
  report("Claiming: the member's own login owns the profile, with MemberAccountClaimed",
    !!(await prisma.personAccount.findFirst({ where: { personId: teen.childPersonId, userId: claimed.userId, role: "OWNER" } })) && (await eventsOf(teen.childPersonId, "MemberAccountClaimed")).length === 1);
  report("…the manager still sees nothing until the member chooses", await notFound(viewMember(M.userId, teen.childPersonId)));
  await restoreGrant(claimed.userId, teen.grantId, { permissions: ["VIEW"], categories: ["LABS"] });
  report("The member restores only what they choose: VIEW of labs, as MEMBER_CHOICE", (await prisma.proxyGrant.findFirstOrThrow({ where: { memberPersonId: teen.childPersonId, status: "ACTIVE" } })).basis === "MEMBER_CHOICE" && !!(await viewMember(M.userId, teen.childPersonId)));

  // 5. In person, without phone or email.
  const other = await child(M, 17);
  await sweepComingOfAge({ now: new Date(comingOfAge((await prisma.person.findUniqueOrThrow({ where: { id: other.childPersonId } })).dateOfBirth!, "DAY").getTime() + 60_000) });
  const s1 = await staff(PUNE, "HOSPITAL_ADMIN");
  report("In person: the staff member must record the ID seen", await refused(startClaimInPerson({ userId: s1.userId, staffId: s1.staffId, facilityId: PUNE }, other.childPersonId, { idType: "AADHAAR", idLast4: "" })));
  const ip = await startClaimInPerson({ userId: s1.userId, staffId: s1.staffId, facilityId: PUNE }, other.childPersonId, { idType: "AADHAAR", idLast4: "1234" });
  const c2 = await completeClaim(ip.claimId, ip.code, { email: `teen2-${tag}@verify.aarogya`, password: "another-long-pw-2" });
  report("…hands over a code; the member claims with it", !!c2.userId && (await prisma.auditEvent.count({ where: { type: "household.claim.inPerson", userId: s1.userId } })) === 1);

  // 6. A dependent adult takes control back.
  const { addDependentAdult } = await import("../src/lib/household/households");
  const { staffInPersonCheck } = await import("../src/lib/household/dependentConsent");
  const dep = await addDependentAdult(M.userId, M.householdId, { displayName: `Dep ${tag}`, relationship: "SIBLING" });
  const n1 = await staff(PUNE, "NURSE"), n2 = await staff(PUNE, "NURSE");
  await staffInPersonCheck({ userId: n1.userId, staffId: n1.staffId, facilityId: PUNE }, dep.adultPersonId, M.personId);
  await staffInPersonCheck({ userId: n2.userId, staffId: n2.staffId, facilityId: PUNE }, dep.adultPersonId, M.personId);
  const ipd = await startClaimInPerson({ userId: s1.userId, staffId: s1.staffId, facilityId: PUNE }, dep.adultPersonId, { idType: "VOTER_ID", idLast4: "9X8Y" });
  await completeClaim(ipd.claimId, ipd.code, { email: `dep-${tag}@verify.aarogya`, password: "dependent-pw-333" });
  report("A dependent adult takes control back: the recorded-consent grant lapses (MEMBER_CLAIMED), nothing visible (404)",
    (await prisma.proxyGrant.findUniqueOrThrow({ where: { id: dep.grantId } })).lapsedReason === "MEMBER_CLAIMED" && await notFound(viewMember(M.userId, dep.adultPersonId)));

  await done();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
