import { createHash, randomInt } from "node:crypto";
import type { HouseholdMember, Prisma, ProxyPermission } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { emitDomainEvent } from "@/lib/events/emit";
import { sendSms, maskPhone } from "@/lib/messaging/sms";
import { sendEmail } from "@/lib/email/send";
import { ownedPersonId, requireOwnedPerson } from "@/lib/person/access";
import { ALL_PERMISSIONS, grantEventTx, parseCategories, parsePermissions } from "./grants";
import { ADULT_RELATIONSHIPS, CODE_TTL_MINUTES, GUARDIAN_RELATIONSHIPS, LEGAL_DOCUMENT_KINDS, MAX_MEMBERS, PARENTAL_DECLARATION, ageOn, ADULT_AT } from "./vocab";

/**
 * Week 5b — households (docs/HOUSEHOLD_DESIGN.md §2–§4, and the 5b decisions).
 * A household groups Persons; it never shares a record. Membership confers
 * nothing: grants do (./grants.ts).
 *
 *   SELF             the manager's own profile.
 *   MANAGED_MINOR    a child's own Person with no login, added by a parent or
 *                    legal guardian after verifiable parental consent: a code
 *                    to the manager's own verified phone and the relationship
 *                    declaration (pending lawyer review). A date of birth is
 *                    required. The manager gets a GUARDIAN grant (every
 *                    permission, the default categories, nothing sensitive).
 *   DEPENDENT_ADULT  an adult's own Person whose proxy needs the adult's
 *                    consent recorded by one of three methods: the adult's
 *                    own code (to their own contact), a two-staff in-person
 *                    check, or a staff-reviewed legal document. The grant is
 *                    PENDING_CONFIRMATION until then.
 *   LINKED_ADULT     an adult with their own login, invited; they accept and
 *                    choose what each proxy may do (MEMBER_CHOICE).
 * At most 8 members per household. Every change emits its event.
 */
export const hashCode = (code: string) => createHash("sha256").update(code).digest("hex");
const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

async function memberEventTx(tx: Prisma.TransactionClient, m: HouseholdMember, from: string | null, actorUserId: string | null) {
  await emitDomainEvent(tx, {
    type: "HouseholdMemberStatusChanged", aggregateId: m.id, personId: m.personId, actorUserId,
    payload: { personId: m.personId, householdId: m.householdId, memberId: m.id, memberPersonId: m.personId, memberType: m.memberType, from: from as never, to: m.status },
  });
}

/** The caller's household as a manager (404 otherwise). */
export async function requireManaged(userId: string, householdId: string) {
  const personId = await requireOwnedPerson(userId);
  const me = await prisma.householdMember.findFirst({ where: { householdId, personId, role: "MANAGER", status: "ACTIVE" }, include: { household: true } });
  if (!me || me.household.status !== "ACTIVE") throw new NotFoundError();
  return { personId, household: me.household };
}

async function assertRoom(tx: Pick<Prisma.TransactionClient, "householdMember">, householdId: string) {
  const n = await tx.householdMember.count({ where: { householdId, status: { in: ["INVITED", "PENDING_CONSENT", "ACTIVE"] } } });
  if (n >= MAX_MEMBERS) throw new ConflictError(`A household has at most ${MAX_MEMBERS} members.`);
}

export async function createHousehold(userId: string, name: unknown) {
  const personId = await requireOwnedPerson(userId);
  const n = typeof name === "string" && name.trim() ? name.trim().slice(0, 80) : "My family";
  return prisma.$transaction(async (tx) => {
    const h = await tx.household.create({ data: { name: n, createdByPersonId: personId } });
    const m = await tx.householdMember.create({ data: { householdId: h.id, personId, memberType: "SELF", role: "MANAGER", status: "ACTIVE", joinedAt: new Date() } });
    await emitDomainEvent(tx, { type: "HouseholdCreated", aggregateId: h.id, personId, actorUserId: userId, payload: { householdId: h.id, personId } });
    await memberEventTx(tx, m, null, userId);
    return h;
  });
}

/** The manager's verified phone (where the parental-consent code goes). */
async function managerPhone(personId: string) {
  return prisma.personContact.findFirst({ where: { personId, kind: "PHONE", status: "ACTIVE", verifiedAt: { not: null } }, orderBy: { verifiedAt: "desc" } });
}

/**
 * Step 1 of adding a child: the declaration and the child's details; a code
 * goes to the manager's own verified phone. Nothing is created until the
 * code is confirmed (step 2).
 */
export async function startAddMinor(userId: string, householdId: string, body: Record<string, unknown>) {
  const { personId } = await requireManaged(userId, householdId);
  const relationship = String(body.relationship ?? "");
  if (!(GUARDIAN_RELATIONSHIPS as readonly string[]).includes(relationship)) throw new BadRequestError(`relationship must be one of ${GUARDIAN_RELATIONSHIPS.join(", ")}.`);
  if (body.declaration !== true) throw new BadRequestError("Confirm the declaration that you are the child's parent or legal guardian.");
  const displayName = typeof body.displayName === "string" ? body.displayName.trim().slice(0, 120) : "";
  if (!displayName) throw new BadRequestError("The child's name is required.");
  const dob = new Date(String(body.dateOfBirth ?? ""));
  if (Number.isNaN(dob.getTime()) || !/^\d{4}-\d{2}-\d{2}$/.test(String(body.dateOfBirth))) throw new BadRequestError("A full date of birth (YYYY-MM-DD) is required for a child's profile.");
  if (ageOn(dob, new Date()) >= ADULT_AT || dob > new Date()) throw new BadRequestError("A managed child's profile is for someone under 18.");
  const phone = await managerPhone(personId);
  if (!phone) throw new ConflictError("Verify your own phone number first: the consent code goes to it.");
  await assertRoom(prisma, householdId);
  const code = newCode();
  const consent = await prisma.parentalConsent.create({
    data: {
      householdId, minorDisplayName: displayName, minorDateOfBirth: dob, minorSex: typeof body.sex === "string" ? body.sex.slice(0, 1) : null,
      parentPersonId: personId, relationship, phoneLast4: phone.value.slice(-4), codeHash: hashCode(code),
      codeExpiresAt: new Date(Date.now() + CODE_TTL_MINUTES * 60_000), declarationText: PARENTAL_DECLARATION,
    },
  });
  const sent = await sendSms(phone.value, `Aarogya: your code to add your child's profile is ${code}. It expires in ${CODE_TTL_MINUTES} minutes. Don't share it.`);
  if (!sent.delivered) throw new ConflictError("The code couldn't be sent. Try again later.");
  return { consentId: consent.id, sentTo: maskPhone(phone.value), expiresAt: consent.codeExpiresAt.toISOString() };
}

/** Step 2: the code confirms the consent; the child's Person, membership and the GUARDIAN grant are created together. */
export async function confirmAddMinor(userId: string, consentId: string, code: unknown) {
  const personId = await requireOwnedPerson(userId);
  const c = await prisma.parentalConsent.findUnique({ where: { id: consentId } });
  if (!c || c.parentPersonId !== personId || c.confirmedAt) throw new NotFoundError();
  if (c.codeExpiresAt < new Date() || typeof code !== "string" || hashCode(code.trim()) !== c.codeHash) throw new BadRequestError("That code isn't right or has expired.");
  await requireManaged(userId, c.householdId);
  const out = await prisma.$transaction(async (tx) => {
    await assertRoom(tx, c.householdId);
    const r = await tx.parentalConsent.updateMany({ where: { id: c.id, confirmedAt: null }, data: { confirmedAt: new Date() } });
    if (r.count !== 1) throw new ConflictError("Already confirmed.");
    // A managed profile has its creator's data classification (a synthetic demo or gate family stays synthetic).
    const { dataClassification } = await tx.person.findUniqueOrThrow({ where: { id: personId }, select: { dataClassification: true } });
    const child = await tx.person.create({ data: { displayName: c.minorDisplayName, dateOfBirth: c.minorDateOfBirth, dobPrecision: "DAY", sex: c.minorSex ?? undefined, managedByHousehold: true, dataClassification } });
    await tx.parentalConsent.update({ where: { id: c.id }, data: { minorPersonId: child.id } });
    await emitDomainEvent(tx, { type: "PersonCreated", aggregateId: child.id, personId: child.id, actorUserId: userId, payload: { personId: child.id, source: "HOUSEHOLD" } });
    await tx.personAccessLogEntry.create({ data: { personId: child.id, kind: "PERSON_CREATED", actorUserId: userId, detail: { source: "HOUSEHOLD", parentalConsentId: c.id } } });
    const m = await tx.householdMember.create({ data: { householdId: c.householdId, personId: child.id, memberType: "MANAGED_MINOR", role: "MEMBER", status: "ACTIVE", relationship: c.relationship, joinedAt: new Date() } });
    await memberEventTx(tx, m, null, userId);
    const g = await tx.proxyGrant.create({
      data: {
        memberPersonId: child.id, proxyPersonId: personId, householdId: c.householdId, basis: "GUARDIAN", permissions: ALL_PERMISSIONS,
        categories: parseCategories(undefined), sensitiveCategories: [], status: "ACTIVE", grantedByPersonId: personId,
        evidence: { method: "PARENTAL_CONSENT", parentalConsentId: c.id, relationship: c.relationship },
      },
    });
    await grantEventTx(tx, g, null, userId);
    return { childPersonId: child.id, memberId: m.id, grantId: g.id };
  });
  await recordAuditEvent("household.minor.added", userId, { householdId: c.householdId, ...out });
  return out;
}

/**
 * A dependent adult's profile (no login of their own yet): the membership
 * and a RECORDED_CONSENT grant, both waiting for the adult's consent by one
 * of three methods (dependentConsent.ts). Their contact (phone or email) is
 * where the OWN_CODE method's code goes.
 */
export async function addDependentAdult(userId: string, householdId: string, body: Record<string, unknown>) {
  const { personId } = await requireManaged(userId, householdId);
  const relationship = String(body.relationship ?? "");
  if (!(ADULT_RELATIONSHIPS as readonly string[]).includes(relationship)) throw new BadRequestError(`relationship must be one of ${ADULT_RELATIONSHIPS.join(", ")}.`);
  const displayName = typeof body.displayName === "string" ? body.displayName.trim().slice(0, 120) : "";
  if (!displayName) throw new BadRequestError("Their name is required.");
  const dob = body.dateOfBirth ? new Date(String(body.dateOfBirth)) : null;
  if (dob && (Number.isNaN(dob.getTime()) || ageOn(dob, new Date()) < ADULT_AT)) throw new BadRequestError("A dependent adult is 18 or over; add a child as a managed child.");
  const permissions: ProxyPermission[] = body.permissions === undefined ? ["VIEW", "BOOK"] : parsePermissions(body.permissions);
  const categories = parseCategories(body.categories);
  const contact = typeof body.phone === "string" && body.phone.trim() ? { kind: "PHONE" as const, value: body.phone.trim() } : typeof body.email === "string" && body.email.trim() ? { kind: "EMAIL" as const, value: body.email.trim().toLowerCase() } : null;
  // Their OWN contact (where their consent code goes): never one that belongs to someone else, the manager included.
  if (contact && (await prisma.personContact.findFirst({ where: { kind: contact.kind, value: contact.value }, select: { id: true } }))) {
    throw new BadRequestError("That phone or email belongs to another profile. Give the adult's own, or use an in-person check or a legal document.");
  }
  const out = await prisma.$transaction(async (tx) => {
    await assertRoom(tx, householdId);
    const { dataClassification } = await tx.person.findUniqueOrThrow({ where: { id: personId }, select: { dataClassification: true } });
    const adult = await tx.person.create({ data: { displayName, dateOfBirth: dob ?? undefined, managedByHousehold: true, dataClassification, ...(contact ? { contacts: { create: { kind: contact.kind, value: contact.value } } } : {}) } });
    await emitDomainEvent(tx, { type: "PersonCreated", aggregateId: adult.id, personId: adult.id, actorUserId: userId, payload: { personId: adult.id, source: "HOUSEHOLD" } });
    await tx.personAccessLogEntry.create({ data: { personId: adult.id, kind: "PERSON_CREATED", actorUserId: userId, detail: { source: "HOUSEHOLD" } } });
    const m = await tx.householdMember.create({ data: { householdId, personId: adult.id, memberType: "DEPENDENT_ADULT", role: "MEMBER", status: "PENDING_CONSENT", relationship } });
    await memberEventTx(tx, m, null, userId);
    const g = await tx.proxyGrant.create({ data: { memberPersonId: adult.id, proxyPersonId: personId, householdId, basis: "RECORDED_CONSENT", permissions, categories, status: "PENDING_CONFIRMATION", grantedByPersonId: adult.id } });
    await grantEventTx(tx, g, null, userId);
    return { adultPersonId: adult.id, memberId: m.id, grantId: g.id };
  });
  return out;
}

/** A linked adult: an existing account, invited by email. They accept and choose (MEMBER_CHOICE). */
export async function inviteLinkedAdult(userId: string, householdId: string, email: unknown) {
  await requireManaged(userId, householdId);
  if (typeof email !== "string" || !email.includes("@")) throw new BadRequestError("Their account's email is required.");
  const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() }, select: { id: true } });
  const invitee = user ? await ownedPersonId(user.id) : null;
  // No reveal: the same answer whether or not the account exists.
  if (!invitee) return { status: "INVITED" as const };
  if (await prisma.householdMember.findFirst({ where: { householdId, personId: invitee, status: { in: ["INVITED", "ACTIVE", "PENDING_CONSENT"] } } })) return { status: "INVITED" as const };
  await prisma.$transaction(async (tx) => {
    await assertRoom(tx, householdId);
    const m = await tx.householdMember.create({ data: { householdId, personId: invitee, memberType: "LINKED_ADULT", role: "MEMBER", status: "INVITED" } });
    await memberEventTx(tx, m, null, userId);
  });
  await sendEmail({ to: email.trim().toLowerCase(), subject: "You've been invited to a family on Aarogya", text: "Someone invited you to their family on Aarogya. Open the app to accept or decline. Nobody sees your record unless you choose what they may see." }).catch(() => undefined);
  return { status: "INVITED" as const };
}

/** The invited adult accepts, choosing what the household's managers may do (or nothing yet). */
export async function acceptInvitation(userId: string, memberId: string, body: Record<string, unknown>) {
  const personId = await requireOwnedPerson(userId);
  const m = await prisma.householdMember.findUnique({ where: { id: memberId } });
  if (!m || m.personId !== personId || m.status !== "INVITED") throw new NotFoundError();
  const grantTo = body.permissions === undefined ? null : { permissions: parsePermissions(body.permissions), categories: parseCategories(body.categories) };
  return prisma.$transaction(async (tx) => {
    await tx.householdMember.update({ where: { id: m.id }, data: { status: "ACTIVE", joinedAt: new Date(), version: { increment: 1 } } });
    await memberEventTx(tx, { ...m, status: "ACTIVE" }, "INVITED", userId);
    const grants: string[] = [];
    if (grantTo) {
      for (const mgr of await tx.householdMember.findMany({ where: { householdId: m.householdId, role: "MANAGER", status: "ACTIVE" } })) {
        const g = await tx.proxyGrant.create({ data: { memberPersonId: personId, proxyPersonId: mgr.personId, householdId: m.householdId, basis: "MEMBER_CHOICE", ...grantTo, status: "ACTIVE", grantedByPersonId: personId } });
        await grantEventTx(tx, g, null, userId);
        grants.push(g.id);
      }
    }
    return { status: "ACTIVE" as const, grants };
  });
}

/** A member leaves (adults), or a manager removes one; a leaving adult's grants to this household are revoked. */
export async function removeMember(userId: string, memberId: string) {
  const callerPerson = await requireOwnedPerson(userId);
  const m = await prisma.householdMember.findUnique({ where: { id: memberId } });
  if (!m || !["ACTIVE", "INVITED", "PENDING_CONSENT"].includes(m.status)) throw new NotFoundError();
  const self = m.personId === callerPerson;
  if (!self) await requireManaged(userId, m.householdId);
  if (m.memberType === "MANAGED_MINOR" && !self) throw new ConflictError("A child's profile moves only by a guardian, through support.");
  await prisma.$transaction(async (tx) => {
    const to = self ? "LEFT" : "REMOVED";
    await tx.householdMember.update({ where: { id: m.id }, data: { status: to, leftAt: new Date(), version: { increment: 1 } } });
    await memberEventTx(tx, { ...m, status: to }, m.status, userId);
    if (m.memberType !== "MANAGED_MINOR") {
      for (const g of await tx.proxyGrant.findMany({ where: { memberPersonId: m.personId, householdId: m.householdId, status: { in: ["ACTIVE", "PENDING_CONFIRMATION"] } } })) {
        await tx.proxyGrant.update({ where: { id: g.id }, data: { status: "REVOKED", revokedAt: new Date(), version: { increment: 1 } } });
        await grantEventTx(tx, { ...g, status: "REVOKED" }, g.status, userId);
      }
    }
  });
  return { status: self ? "LEFT" : "REMOVED" };
}

/** The households the caller belongs to, with members (names and types only) and the caller's role. */
export async function myHouseholds(userId: string) {
  const personId = await requireOwnedPerson(userId);
  const mine = await prisma.householdMember.findMany({ where: { personId, status: { in: ["ACTIVE", "INVITED"] } }, include: { household: { include: { members: { where: { status: { in: ["ACTIVE", "INVITED", "PENDING_CONSENT"] } } } } } } });
  const ids = mine.flatMap((m) => m.household.members.map((x) => x.personId));
  const people = await prisma.person.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } });
  return mine.map((m) => ({
    householdId: m.householdId, name: m.household.name, myRole: m.role, myStatus: m.status, myMemberId: m.id,
    members: m.household.members.map((x) => ({ memberId: x.id, personId: x.personId, name: people.find((p) => p.id === x.personId)?.displayName ?? "", memberType: x.memberType, role: x.role, status: x.status, me: x.personId === personId })),
  }));
}

/** The legal-document kinds a staff member may accept for a dependent adult. */
export const LEGAL_KINDS = LEGAL_DOCUMENT_KINDS;
