import { randomInt } from "node:crypto";
import { prisma } from "@/lib/db";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { emitDomainEvent } from "@/lib/events/emit";
import { sendSms, maskPhone } from "@/lib/messaging/sms";
import { sendEmail } from "@/lib/email/send";
import { hashPassword } from "@/lib/auth/password";
import { isStaffInFacility } from "@/lib/auth/staffFacility";
import { queuePersonNotificationTx } from "@/lib/person/notifications";
import { grantEventTx } from "./grants";
import { hashCode, requireManaged } from "./households";
import { CODE_TTL_MINUTES, COMING_OF_AGE_NOTICE_DAYS, comingOfAge } from "./vocab";

/**
 * Week 5b — coming of age, and claiming a profile (docs/HOUSEHOLD_DESIGN.md §6).
 *
 * The runner's sweep (daily in effect; idempotent):
 *   - 30 days before: the managers are told (PersonNotification COMING_OF_AGE).
 *   - on the day (the 18th birthday; for a coarser date, 1 January of the
 *     following year): every GUARDIAN grant lapses (LAPSED, CAME_OF_AGE), the
 *     guardian-given consents lapse (the Week 4b sweep), and the member awaits
 *     a claim (MemberCameOfAge). The managers see nothing from then on unless
 *     the member, having claimed, chooses to give it back.
 *
 * Claiming (and a dependent adult taking control back): the member gets their
 * own login. OWN_CONTACT sends a code to their own verified phone or email;
 * without one, IN_PERSON: a facility's staff member verifies them in person
 * and hands over a one-time code (5b decision). On claiming, every grant
 * about them that was GUARDIAN or RECORDED_CONSENT is lapsed (MEMBER_CLAIMED)
 * and listed for them to restore one by one (as MEMBER_CHOICE) or not.
 */
export async function sweepComingOfAge(opts: { now?: Date; batchSize?: number } = {}): Promise<{ noticed: number; cameOfAge: number }> {
  const now = opts.now ?? new Date();
  const minors = await prisma.householdMember.findMany({ where: { memberType: "MANAGED_MINOR", status: "ACTIVE" }, take: opts.batchSize ?? 500 });
  const people = await prisma.person.findMany({ where: { id: { in: minors.map((m) => m.personId) } }, select: { id: true, dateOfBirth: true, dobPrecision: true } });
  let noticed = 0, cameOfAge = 0;
  for (const m of minors) {
    const p = people.find((x) => x.id === m.personId);
    if (!p?.dateOfBirth) continue;
    const at = comingOfAge(p.dateOfBirth, p.dobPrecision);
    if (at <= now) {
      await prisma.$transaction(async (tx) => {
        const r = await tx.householdMember.updateMany({ where: { id: m.id, status: "ACTIVE", memberType: "MANAGED_MINOR" }, data: { memberType: "DEPENDENT_ADULT", status: "AWAITING_CLAIM", version: { increment: 1 } } });
        if (r.count !== 1) return;
        for (const g of await tx.proxyGrant.findMany({ where: { memberPersonId: m.personId, basis: "GUARDIAN", status: { in: ["ACTIVE", "PENDING_CONFIRMATION"] } } })) {
          await tx.proxyGrant.update({ where: { id: g.id }, data: { status: "LAPSED", lapsedReason: "CAME_OF_AGE", version: { increment: 1 } } });
          await grantEventTx(tx, { ...g, status: "LAPSED", lapsedReason: "CAME_OF_AGE" }, g.status, null);
        }
        await emitDomainEvent(tx, { type: "MemberCameOfAge", aggregateId: m.personId, personId: m.personId, payload: { personId: m.personId, memberPersonId: m.personId, householdId: m.householdId } });
        await emitDomainEvent(tx, { type: "HouseholdMemberStatusChanged", aggregateId: m.id, personId: m.personId, payload: { personId: m.personId, householdId: m.householdId, memberId: m.id, memberPersonId: m.personId, memberType: "DEPENDENT_ADULT", from: "ACTIVE", to: "AWAITING_CLAIM" } });
        cameOfAge += 1;
      });
    } else if (at.getTime() - now.getTime() <= COMING_OF_AGE_NOTICE_DAYS * 86_400_000) {
      for (const mgr of await prisma.householdMember.findMany({ where: { householdId: m.householdId, role: "MANAGER", status: "ACTIVE" } })) {
        const id = await prisma.$transaction((tx) => queuePersonNotificationTx(tx, { personId: mgr.personId, kind: "COMING_OF_AGE", dedupeKey: `COMING_OF_AGE:${m.personId}:${mgr.personId}`, detail: { days: Math.ceil((at.getTime() - now.getTime()) / 86_400_000) } }));
        if (id) noticed += 1;
      }
    }
  }
  return { noticed, cameOfAge };
}

/** OWN_CONTACT: a manager (the hand-over) or the member's own contact starts the claim; the code goes to the member's own verified contact. */
export async function startClaimOwnContact(userId: string, householdId: string, memberPersonId: string) {
  const { personId } = await requireManaged(userId, householdId);
  const m = await prisma.householdMember.findFirst({ where: { householdId, personId: memberPersonId, status: { in: ["ACTIVE", "AWAITING_CLAIM", "PENDING_CONSENT"] } } });
  if (!m || m.memberType === "LINKED_ADULT" || m.memberType === "SELF") throw new NotFoundError();
  const contact = await prisma.personContact.findFirst({ where: { personId: memberPersonId, status: "ACTIVE", verifiedAt: { not: null } }, orderBy: { verifiedAt: "desc" } });
  if (!contact) throw new ConflictError("They have no verified phone or email of their own: they claim in person at a facility.");
  const managerContacts = await prisma.personContact.findMany({ where: { personId, status: "ACTIVE" }, select: { value: true } });
  if (managerContacts.some((x) => x.value === contact.value)) throw new ConflictError("The claim code must go to their own phone or email, not yours.");
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const claim = await prisma.memberClaim.create({ data: { personId: memberPersonId, method: "OWN_CONTACT", contactKind: contact.kind, contactValue: contact.value, codeHash: hashCode(code), codeExpiresAt: new Date(Date.now() + CODE_TTL_MINUTES * 60_000) } });
  const text = `Aarogya: your health record is ready for you to take over. Your code is ${code} (expires in ${CODE_TTL_MINUTES} minutes). Use it in the app with "Claim my profile".`;
  const sent = contact.kind === "PHONE" ? await sendSms(contact.value, text) : await sendEmail({ to: contact.value, subject: "Take over your Aarogya health record", text });
  if (!sent.delivered) throw new ConflictError("The code couldn't be sent. Try again later.");
  return { claimId: claim.id, sentTo: contact.kind === "PHONE" ? maskPhone(contact.value) : "their email" };
}

/** IN_PERSON: a facility's staff member verified the member in person (ID seen) and hands over a one-time code. */
export async function startClaimInPerson(staff: { userId: string; staffId: string; facilityId: string }, memberPersonId: string, idCheck: { idType: unknown; idLast4: unknown }) {
  if (!(await isStaffInFacility(prisma, staff.staffId, staff.facilityId))) throw new NotFoundError();
  const m = await prisma.householdMember.findFirst({ where: { personId: memberPersonId, memberType: { in: ["MANAGED_MINOR", "DEPENDENT_ADULT"] }, status: { in: ["ACTIVE", "AWAITING_CLAIM", "PENDING_CONSENT"] } } });
  if (!m) throw new NotFoundError();
  if (typeof idCheck.idType !== "string" || typeof idCheck.idLast4 !== "string" || !/^[0-9A-Z]{4}$/i.test(idCheck.idLast4)) throw new BadRequestError("Record the ID seen (type and its last 4 characters).");
  const code = String(randomInt(0, 100_000_000)).padStart(8, "0");
  const claim = await prisma.memberClaim.create({ data: { personId: memberPersonId, method: "IN_PERSON", codeHash: hashCode(code), codeExpiresAt: new Date(Date.now() + CODE_TTL_MINUTES * 60_000), verifiedByStaffUserId: staff.userId } });
  await recordAuditEvent("household.claim.inPerson", staff.userId, { claimId: claim.id, idType: idCheck.idType, idLast4: idCheck.idLast4.toUpperCase() }, { facilityId: staff.facilityId });
  return { claimId: claim.id, code, expiresAt: claim.codeExpiresAt!.toISOString() };
}

/**
 * The member completes the claim with the code: their own login (email and
 * password) becomes the profile's OWNER. Guardian and recorded-consent grants
 * lapse (MEMBER_CLAIMED); the member then restores any, one by one.
 */
export async function completeClaim(claimId: string, code: unknown, account: { email: unknown; password: unknown }) {
  const claim = await prisma.memberClaim.findUnique({ where: { id: claimId } });
  if (!claim || claim.status !== "OPEN") throw new NotFoundError();
  if (!claim.codeExpiresAt || claim.codeExpiresAt < new Date() || typeof code !== "string" || hashCode(code.trim()) !== claim.codeHash) throw new BadRequestError("That code isn't right or has expired.");
  if (typeof account.email !== "string" || !account.email.includes("@")) throw new BadRequestError("An email is required for your login.");
  if (typeof account.password !== "string" || account.password.length < 10) throw new BadRequestError("Choose a password of at least 10 characters.");
  const email = account.email.trim().toLowerCase();
  if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) throw new ConflictError("That email already has an account. Use another.");
  if (await prisma.personAccount.findFirst({ where: { personId: claim.personId, role: "OWNER", endedAt: null } })) throw new ConflictError("This profile already has its own login.");
  const person = await prisma.person.findUniqueOrThrow({ where: { id: claim.personId }, select: { displayName: true } });
  const passwordHash = await hashPassword(account.password);
  const out = await prisma.$transaction(async (tx) => {
    const r = await tx.memberClaim.updateMany({ where: { id: claim.id, status: "OPEN" }, data: { status: "COMPLETED", completedAt: new Date() } });
    if (r.count !== 1) throw new ConflictError("Already claimed.");
    const user = await tx.user.create({ data: { email, passwordHash, role: "PATIENT", displayName: person.displayName } });
    await tx.personAccount.create({ data: { personId: claim.personId, userId: user.id, role: "OWNER" } });
    await tx.person.update({ where: { id: claim.personId }, data: { managedByHousehold: false, version: { increment: 1 } } });
    await tx.memberClaim.update({ where: { id: claim.id }, data: { claimedUserId: user.id } });
    const lapsed: string[] = [];
    for (const g of await tx.proxyGrant.findMany({ where: { memberPersonId: claim.personId, basis: { in: ["GUARDIAN", "RECORDED_CONSENT"] }, status: { in: ["ACTIVE", "PENDING_CONFIRMATION"] } } })) {
      await tx.proxyGrant.update({ where: { id: g.id }, data: { status: "LAPSED", lapsedReason: "MEMBER_CLAIMED", version: { increment: 1 } } });
      await grantEventTx(tx, { ...g, status: "LAPSED", lapsedReason: "MEMBER_CLAIMED" }, g.status, user.id);
      lapsed.push(g.id);
    }
    for (const m of await tx.householdMember.findMany({ where: { personId: claim.personId, status: { in: ["AWAITING_CLAIM", "ACTIVE", "PENDING_CONSENT"] } } })) {
      await tx.householdMember.update({ where: { id: m.id }, data: { memberType: "LINKED_ADULT", status: "ACTIVE", version: { increment: 1 } } });
      await emitDomainEvent(tx, { type: "HouseholdMemberStatusChanged", aggregateId: m.id, personId: m.personId, actorUserId: user.id, payload: { personId: m.personId, householdId: m.householdId, memberId: m.id, memberPersonId: m.personId, memberType: "LINKED_ADULT", from: m.status, to: "ACTIVE" } });
    }
    await tx.personAccessLogEntry.create({ data: { personId: claim.personId, kind: "ACCOUNT_CLAIMED", actorUserId: user.id, detail: { method: claim.method, grantsLapsed: lapsed.length } } });
    await emitDomainEvent(tx, { type: "MemberAccountClaimed", aggregateId: claim.personId, personId: claim.personId, actorUserId: user.id, payload: { personId: claim.personId, memberPersonId: claim.personId, method: claim.method } });
    return { userId: user.id, lapsedGrants: lapsed };
  });
  await recordAuditEvent("household.claim.completed", out.userId, { claimId, method: claim.method });
  return out;
}

/** After claiming: the member restores a lapsed grant (as their own choice), with the permissions they tick. */
export async function restoreGrant(userId: string, grantId: string, body: Record<string, unknown>) {
  const { ownedPersonId } = await import("@/lib/person/access");
  const { parsePermissions, parseCategories, parseSensitive } = await import("./grants");
  const personId = await ownedPersonId(userId);
  const g = await prisma.proxyGrant.findUnique({ where: { id: grantId } });
  if (!personId || !g || g.memberPersonId !== personId || g.status !== "LAPSED") throw new NotFoundError();
  const permissions = parsePermissions(body.permissions);
  const categories = parseCategories(body.categories);
  const sensitiveCategories = await parseSensitive(body.sensitiveCategories, personId, "MEMBER_CHOICE");
  return prisma.$transaction(async (tx) => {
    const n = await tx.proxyGrant.create({ data: { memberPersonId: personId, proxyPersonId: g.proxyPersonId, householdId: g.householdId, basis: "MEMBER_CHOICE", permissions, categories, sensitiveCategories, status: "ACTIVE", grantedByPersonId: personId, evidence: { restoredFrom: g.id } } });
    await grantEventTx(tx, n, null, userId);
    return n;
  });
}
