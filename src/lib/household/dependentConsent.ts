import { randomInt } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { emitDomainEvent } from "@/lib/events/emit";
import { sendSms, maskPhone } from "@/lib/messaging/sms";
import { messageText } from "@/lib/notifications/texts";
import { personLanguage } from "@/lib/person/notifications";
import { sendEmail } from "@/lib/email/send";
import { isStaffInFacility } from "@/lib/auth/staffFacility";
import { grantEventTx } from "./grants";
import { hashCode, requireManaged } from "./households";
import { CODE_TTL_MINUTES, LEGAL_DOCUMENT_KINDS } from "./vocab";

/**
 * Week 5b — a dependent adult's consent to a proxy (5b decision). The proxy
 * grant stays PENDING_CONFIRMATION until one of:
 *   OWN_CODE             the adult confirms with a code sent to their OWN
 *                        contact (not the manager's);
 *   TWO_STAFF_IN_PERSON  two different staff members of the same facility each
 *                        confirm they checked, in person, that the adult
 *                        consents;
 *   LEGAL_DOCUMENT       a staff member reviews a legal document (a power of
 *                        attorney, a guardianship or other court order)
 *                        uploaded to the adult's profile, and accepts it
 *                        (it can read it, 5-minute URL, while it decides).
 * Confirming activates the grant and the membership, each with its event; the
 * record of how is kept on the consent (ids and closed codes only). The adult
 * can take control back at any time by claiming their profile.
 */
async function pendingFor(memberPersonId: string, proxyPersonId: string) {
  const g = await prisma.proxyGrant.findFirst({ where: { memberPersonId, proxyPersonId, status: "PENDING_CONFIRMATION", basis: "RECORDED_CONSENT" } });
  const m = g?.householdId ? await prisma.householdMember.findFirst({ where: { householdId: g.householdId, personId: memberPersonId, status: "PENDING_CONSENT" } }) : null;
  if (!g || !m) throw new NotFoundError();
  return { g, m };
}

async function consentEventTx(tx: Prisma.TransactionClient, c: { id: string; memberPersonId: string; method: string; status: string }, from: string | null, actorUserId: string | null) {
  await emitDomainEvent(tx, { type: "DependentConsentChanged", aggregateId: c.id, personId: c.memberPersonId, actorUserId, payload: { personId: c.memberPersonId, consentId: c.id, memberPersonId: c.memberPersonId, method: c.method as never, from: from as never, to: c.status as never } });
}

/** Confirmed: the grant ACTIVE, the member ACTIVE, the consent CONFIRMED, in one transaction. */
async function confirmTx(tx: Prisma.TransactionClient, consentId: string, actorUserId: string, evidence: Record<string, string>) {
  const c = await tx.dependentConsent.findUniqueOrThrow({ where: { id: consentId } });
  const r = await tx.dependentConsent.updateMany({ where: { id: c.id, status: "PENDING" }, data: { status: "CONFIRMED", decidedAt: new Date(), version: { increment: 1 } } });
  if (r.count !== 1) throw new ConflictError("This consent has already been decided.");
  await consentEventTx(tx, { ...c, status: "CONFIRMED" }, "PENDING", actorUserId);
  const g = await tx.proxyGrant.findFirst({ where: { memberPersonId: c.memberPersonId, proxyPersonId: c.proxyPersonId, status: "PENDING_CONFIRMATION" } });
  if (!g) throw new ConflictError("The proxy request no longer exists.");
  await tx.proxyGrant.update({ where: { id: g.id }, data: { status: "ACTIVE", evidence: { method: c.method, consentId: c.id, ...evidence }, version: { increment: 1 } } });
  await grantEventTx(tx, { ...g, status: "ACTIVE" }, "PENDING_CONFIRMATION", actorUserId);
  const m = await tx.householdMember.findFirst({ where: { householdId: c.householdId, personId: c.memberPersonId, status: "PENDING_CONSENT" } });
  if (m) {
    await tx.householdMember.update({ where: { id: m.id }, data: { status: "ACTIVE", joinedAt: new Date(), version: { increment: 1 } } });
    await emitDomainEvent(tx, { type: "HouseholdMemberStatusChanged", aggregateId: m.id, personId: m.personId, actorUserId, payload: { personId: m.personId, householdId: m.householdId, memberId: m.id, memberPersonId: m.personId, memberType: m.memberType, from: "PENDING_CONSENT", to: "ACTIVE" } });
  }
}

/** OWN_CODE, step 1 (the manager starts it): a code to the adult's own contact. */
export async function sendOwnCode(userId: string, householdId: string, memberPersonId: string) {
  const { personId } = await requireManaged(userId, householdId);
  await pendingFor(memberPersonId, personId);
  const contact = await prisma.personContact.findFirst({ where: { personId: memberPersonId, status: "ACTIVE" }, orderBy: { createdAt: "asc" } });
  if (!contact) throw new ConflictError("Add their own phone or email first, or use an in-person check or a legal document.");
  const managerContacts = await prisma.personContact.findMany({ where: { personId, status: "ACTIVE" }, select: { value: true } });
  if (managerContacts.some((x) => x.value === contact.value)) throw new ConflictError("The code must go to their own phone or email, not yours.");
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const c = await prisma.$transaction(async (tx) => {
    const c = await tx.dependentConsent.create({ data: { memberPersonId, proxyPersonId: personId, householdId, method: "OWN_CODE", codeHash: hashCode(code), codeExpiresAt: new Date(Date.now() + CODE_TTL_MINUTES * 60_000) } });
    await consentEventTx(tx, c, null, userId);
    return c;
  });
  // In the member's own language: the message is for them (Flagship 1b).
  const lang = await personLanguage(memberPersonId);
  const text = messageText("code.DEPENDENT_CONSENT", lang, { code, minutes: CODE_TTL_MINUTES }).text;
  const sent = contact.kind === "PHONE" ? await sendSms(contact.value, text) : await sendEmail({ to: contact.value, subject: messageText("code.DEPENDENT_CONSENT.subject", lang).text, text });
  if (!sent.delivered) throw new ConflictError("The code couldn't be sent. Try again later.");
  return { consentId: c.id, sentTo: contact.kind === "PHONE" ? maskPhone(contact.value) : contact.value.replace(/^(.).*(@.*)$/, "$1•••$2") };
}

/** OWN_CODE, step 2: the code the adult gave. */
export async function confirmOwnCode(userId: string, consentId: string, code: unknown) {
  const c = await prisma.dependentConsent.findUnique({ where: { id: consentId } });
  if (!c || c.method !== "OWN_CODE" || c.status !== "PENDING") throw new NotFoundError();
  await requireManaged(userId, c.householdId);
  if (!c.codeExpiresAt || c.codeExpiresAt < new Date() || typeof code !== "string" || hashCode(code.trim()) !== c.codeHash) throw new BadRequestError("That code isn't right or has expired.");
  await prisma.$transaction((tx) => confirmTx(tx, c.id, userId, {}));
  await recordAuditEvent("household.dependent.confirmed", userId, { consentId: c.id, method: "OWN_CODE" });
  return { status: "CONFIRMED" as const };
}

/**
 * TWO_STAFF_IN_PERSON: a staff member of a facility records that they checked
 * in person; a second, different staff member of the same facility confirms.
 * Staff act on a request id the household shows them (the adult present).
 */
export async function staffInPersonCheck(staff: { userId: string; staffId: string; facilityId: string }, memberPersonId: string, proxyPersonId: string) {
  if (!(await isStaffInFacility(prisma, staff.staffId, staff.facilityId))) throw new NotFoundError();
  const { g } = await pendingFor(memberPersonId, proxyPersonId);
  const open = await prisma.dependentConsent.findFirst({ where: { memberPersonId, proxyPersonId, method: "TWO_STAFF_IN_PERSON", status: "PENDING" } });
  if (!open) {
    const c = await prisma.$transaction(async (tx) => {
      const c = await tx.dependentConsent.create({ data: { memberPersonId, proxyPersonId, householdId: g.householdId!, method: "TWO_STAFF_IN_PERSON", firstStaffUserId: staff.userId, facilityId: staff.facilityId } });
      await consentEventTx(tx, c, null, staff.userId);
      return c;
    });
    await recordAuditEvent("household.dependent.firstCheck", staff.userId, { consentId: c.id }, { facilityId: staff.facilityId });
    return { consentId: c.id, status: "PENDING" as const, needs: "A second staff member of this facility confirms." };
  }
  if (open.facilityId !== staff.facilityId) throw new ConflictError("The second check must be at the same facility.");
  if (open.firstStaffUserId === staff.userId) throw new ConflictError("A different staff member must make the second check.");
  await prisma.$transaction(async (tx) => {
    await tx.dependentConsent.update({ where: { id: open.id }, data: { secondStaffUserId: staff.userId } });
    await confirmTx(tx, open.id, staff.userId, { firstStaffUserId: open.firstStaffUserId!, secondStaffUserId: staff.userId, facilityId: staff.facilityId });
  });
  await recordAuditEvent("household.dependent.confirmed", staff.userId, { consentId: open.id, method: "TWO_STAFF_IN_PERSON" }, { facilityId: staff.facilityId });
  return { consentId: open.id, status: "CONFIRMED" as const };
}

/** LEGAL_DOCUMENT, step 1 (the manager): the uploaded document (on the adult's profile) is put up for review. */
export async function submitLegalDocument(userId: string, householdId: string, memberPersonId: string, documentId: string, kind: unknown) {
  const { personId } = await requireManaged(userId, householdId);
  await pendingFor(memberPersonId, personId);
  if (!(LEGAL_DOCUMENT_KINDS as readonly string[]).includes(String(kind))) throw new BadRequestError(`kind must be one of ${LEGAL_DOCUMENT_KINDS.join(", ")}.`);
  const doc = await prisma.personDocument.findUnique({ where: { id: documentId } });
  if (!doc || doc.personId !== memberPersonId || doc.status !== "CURRENT") throw new NotFoundError();
  return prisma.$transaction(async (tx) => {
    const c = await tx.dependentConsent.create({ data: { memberPersonId, proxyPersonId: personId, householdId, method: "LEGAL_DOCUMENT", legalDocumentId: documentId, documentKind: String(kind) } });
    await consentEventTx(tx, c, null, userId);
    return { consentId: c.id, status: "PENDING" as const };
  });
}

/** LEGAL_DOCUMENT, step 2: a staff member who reviewed it accepts or refuses. Refusal leaves the grant pending. */
export async function reviewLegalDocument(staff: { userId: string; staffId: string; facilityId: string }, consentId: string, accept: boolean) {
  if (!(await isStaffInFacility(prisma, staff.staffId, staff.facilityId))) throw new NotFoundError();
  const c = await prisma.dependentConsent.findUnique({ where: { id: consentId } });
  if (!c || c.method !== "LEGAL_DOCUMENT" || c.status !== "PENDING") throw new NotFoundError();
  await prisma.$transaction(async (tx) => {
    await tx.dependentConsent.update({ where: { id: c.id }, data: { reviewedByUserId: staff.userId, facilityId: staff.facilityId } });
    if (accept) await confirmTx(tx, c.id, staff.userId, { documentId: c.legalDocumentId!, documentKind: c.documentKind!, reviewedByUserId: staff.userId });
    else {
      await tx.dependentConsent.update({ where: { id: c.id }, data: { status: "REFUSED", decidedAt: new Date(), version: { increment: 1 } } });
      await consentEventTx(tx, { ...c, status: "REFUSED" }, "PENDING", staff.userId);
    }
  });
  await recordAuditEvent("household.dependent.documentReviewed", staff.userId, { consentId, accept }, { facilityId: staff.facilityId });
  return { status: accept ? ("CONFIRMED" as const) : ("REFUSED" as const) };
}

/** LEGAL_DOCUMENT: the reviewing staff member reads the document (5-minute URL, audited) while the consent is pending. */
export async function legalDocumentUrl(staff: { userId: string; staffId: string; facilityId: string }, consentId: string) {
  if (!(await isStaffInFacility(prisma, staff.staffId, staff.facilityId))) throw new NotFoundError();
  const c = await prisma.dependentConsent.findUnique({ where: { id: consentId } });
  if (!c || c.method !== "LEGAL_DOCUMENT" || c.status !== "PENDING" || !c.legalDocumentId) throw new NotFoundError();
  const doc = await prisma.personDocument.findUnique({ where: { id: c.legalDocumentId } });
  if (!doc || doc.personId !== c.memberPersonId || doc.status !== "CURRENT") throw new NotFoundError();
  await prisma.personAccessLogEntry.create({ data: { personId: c.memberPersonId, kind: "RECORD_ACCESSED", actorUserId: staff.userId, accessingFacilityId: staff.facilityId, detail: { via: "LEGAL_DOCUMENT_REVIEW", surface: "DOCUMENT_DOWNLOAD", documentId: doc.id } } });
  await recordAuditEvent("household.dependent.documentReviewed", staff.userId, { consentId, documentId: doc.id, read: true }, { facilityId: staff.facilityId });
  const { getStorageAdapter } = await import("@/lib/storage");
  const { url, expiresAt } = await getStorageAdapter().signedDownloadUrl(doc.storageRef, 300);
  return { url, expiresAt: expiresAt.toISOString() };
}

/**
 * The staff side takes the reference the household's screen shows the family
 * (the member's id), with the adult present: no list of people waiting is
 * ever shown to staff.
 */
export async function staffInPersonCheckByMember(staff: { userId: string; staffId: string; facilityId: string }, memberId: string) {
  const m = await prisma.householdMember.findUnique({ where: { id: memberId }, select: { householdId: true, personId: true, status: true } });
  if (!m || m.status !== "PENDING_CONSENT") throw new NotFoundError();
  const g = await prisma.proxyGrant.findFirst({ where: { memberPersonId: m.personId, householdId: m.householdId, status: "PENDING_CONFIRMATION", basis: "RECORDED_CONSENT" }, select: { proxyPersonId: true } });
  if (!g) throw new NotFoundError();
  return staffInPersonCheck(staff, m.personId, g.proxyPersonId);
}
