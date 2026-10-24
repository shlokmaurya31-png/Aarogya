import { randomInt } from "node:crypto";
import type { PersonConsentDecision, PersonConsentPurpose, ProxyPermission } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { sendSms, maskPhone } from "@/lib/messaging/sms";
import { CONSENT_SCOPES, recordPersonConsentTx } from "@/lib/person/consent";
import { requireProxy } from "./grants";
import { hashCode } from "./households";
import { ADULT_AT, CODE_TTL_MINUTES, GUARDIAN_CONSENT_DECLARATION, GUARDIAN_RELATIONSHIPS, ageOn } from "./vocab";

/**
 * Week 5b follow-up — a guardian decides a managed minor's processing and AI
 * consents (docs/HOUSEHOLD_DESIGN.md §14). A child has no login of their own,
 * so without this a REAL child's uploads are never read.
 *
 *   - Only DOCUMENT_PROCESSING, AI_ASSISTANCE and AI_TEXT_RETENTION. Sharing
 *     with treating hospitals stays a share (4c), made by a proxy with SHARE.
 *   - Only the holder of an ACTIVE GUARDIAN grant for a MANAGED_MINOR under
 *     18, with the permission the purpose needs (UPLOAD for processing,
 *     USE_AI for the AI ones).
 *   - The same parental-consent check as adding the child: a code to the
 *     guardian's own verified phone and the relationship declaration (its
 *     text stored with the check). Pending lawyer review.
 *   - Recorded as the child's PersonConsent with decidedAs GUARDIAN; like
 *     every choice made before 18 it lapses on the 18th birthday
 *     (src/lib/person/consentLapse.ts), and the member then chooses for
 *     themselves.
 * Starting a check writes no consent (a process step); confirming it records
 * the choice with PersonConsentDecided in the same transaction.
 */
export const GUARDIAN_PURPOSES = ["DOCUMENT_PROCESSING", "AI_ASSISTANCE", "AI_TEXT_RETENTION"] as const;
const PERMISSION_FOR: Record<(typeof GUARDIAN_PURPOSES)[number], ProxyPermission> = { DOCUMENT_PROCESSING: "UPLOAD", AI_ASSISTANCE: "USE_AI", AI_TEXT_RETENTION: "USE_AI" };
const MAX_ATTEMPTS = 5;
const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

/** The guardian's grant for a managed minor under 18, or 404. */
async function requireGuardianOf(userId: string, minorPersonId: string, permission: ProxyPermission, at = new Date()) {
  const p = await requireProxy(userId, minorPersonId, permission);
  if (p.grant.basis !== "GUARDIAN") throw new NotFoundError();
  const [minor, member, owner] = await Promise.all([
    prisma.person.findUnique({ where: { id: minorPersonId }, select: { dateOfBirth: true, managedByHousehold: true } }),
    prisma.householdMember.findFirst({ where: { personId: minorPersonId, memberType: "MANAGED_MINOR", status: "ACTIVE" }, select: { id: true } }),
    prisma.personAccount.findFirst({ where: { personId: minorPersonId, role: "OWNER", endedAt: null }, select: { id: true } }),
  ]);
  if (!minor?.managedByHousehold || !member || owner) throw new NotFoundError();
  if (!minor.dateOfBirth || ageOn(minor.dateOfBirth, at) >= ADULT_AT) throw new ConflictError("From 18 the member makes these choices themselves.");
  return p;
}

function parseChoice(body: Record<string, unknown>) {
  const purpose = String(body.purpose ?? "");
  if (!(GUARDIAN_PURPOSES as readonly string[]).includes(purpose)) throw new BadRequestError(`purpose must be one of ${GUARDIAN_PURPOSES.join(", ")}.`);
  const decision = body.decision;
  if (decision !== "GRANTED" && decision !== "DECLINED") throw new BadRequestError("decision must be GRANTED or DECLINED.");
  const scopes = [...new Set(Array.isArray(body.scopes) ? body.scopes.map(String) : [])].sort();
  const allowed = CONSENT_SCOPES[purpose] ?? [];
  if (scopes.some((x) => !allowed.includes(x))) throw new BadRequestError(`Scopes for ${purpose}: ${allowed.join(", ") || "none"}.`);
  if (decision === "DECLINED" && scopes.length) throw new BadRequestError("A declined choice has no scopes.");
  const relationship = String(body.relationship ?? "");
  if (!(GUARDIAN_RELATIONSHIPS as readonly string[]).includes(relationship)) throw new BadRequestError(`relationship must be one of ${GUARDIAN_RELATIONSHIPS.join(", ")}.`);
  if (body.declaration !== true) throw new BadRequestError("Confirm the declaration that you are the child's parent or legal guardian.");
  return { purpose: purpose as (typeof GUARDIAN_PURPOSES)[number], decision: decision as PersonConsentDecision, scopes, relationship };
}

/** Step 1: the choice and the declaration; a code goes to the guardian's own verified phone. Nothing is decided yet. */
export async function startGuardianConsent(userId: string, minorPersonId: string, body: Record<string, unknown>) {
  const choice = parseChoice(body);
  const p = await requireGuardianOf(userId, minorPersonId, PERMISSION_FOR[choice.purpose]);
  const phone = await prisma.personContact.findFirst({ where: { personId: p.proxyPersonId, kind: "PHONE", status: "ACTIVE", verifiedAt: { not: null } }, orderBy: { verifiedAt: "desc" } });
  if (!phone) throw new ConflictError("Verify your own phone number first: the consent code goes to it.");
  const code = newCode();
  const check = await prisma.guardianConsentCheck.create({
    data: {
      minorPersonId, guardianPersonId: p.proxyPersonId, guardianUserId: userId, grantId: p.grant.id, purpose: choice.purpose, decision: choice.decision, scopes: choice.scopes,
      relationship: choice.relationship, declarationText: GUARDIAN_CONSENT_DECLARATION, phoneLast4: phone.value.slice(-4), codeHash: hashCode(code), codeExpiresAt: new Date(Date.now() + CODE_TTL_MINUTES * 60_000),
    },
  });
  const sent = await sendSms(phone.value, `Aarogya: your code to confirm a choice for your child's profile is ${code}. It expires in ${CODE_TTL_MINUTES} minutes. Don't share it.`);
  if (!sent.delivered) throw new ConflictError("The code couldn't be sent. Try again later.");
  return { checkId: check.id, sentTo: maskPhone(phone.value), expiresAt: check.codeExpiresAt.toISOString() };
}

/** Step 2: the code confirms the check; the child's consent is recorded as the guardian's (decidedAs GUARDIAN). */
export async function confirmGuardianConsent(userId: string, checkId: string, code: unknown) {
  const c = await prisma.guardianConsentCheck.findUnique({ where: { id: checkId } });
  if (!c || c.guardianUserId !== userId || c.confirmedAt) throw new NotFoundError();
  if (c.attempts >= MAX_ATTEMPTS) throw new ConflictError("Too many wrong codes. Start again.");
  if (c.codeExpiresAt < new Date() || typeof code !== "string" || hashCode(code.trim()) !== c.codeHash) {
    await prisma.guardianConsentCheck.update({ where: { id: c.id }, data: { attempts: { increment: 1 } } });
    throw new BadRequestError("That code isn't right or has expired.");
  }
  // The grant and the child's age are checked again: either may have changed since the code was sent.
  const p = await requireGuardianOf(userId, c.minorPersonId, PERMISSION_FOR[c.purpose as (typeof GUARDIAN_PURPOSES)[number]]);
  if (p.grant.id !== c.grantId) throw new NotFoundError();
  const out = await prisma.$transaction(async (tx) => {
    const r = await tx.guardianConsentCheck.updateMany({ where: { id: c.id, confirmedAt: null }, data: { confirmedAt: new Date() } });
    if (r.count !== 1) throw new ConflictError("Already confirmed.");
    const { consent } = await recordPersonConsentTx(tx, { personId: c.minorPersonId, userId, purpose: c.purpose, decision: c.decision, scopes: c.scopes, guardianCheckId: c.id });
    await tx.guardianConsentCheck.update({ where: { id: c.id }, data: { consentId: consent.id } });
    return consent;
  });
  await recordAuditEvent("household.guardianConsent.decided", userId, { minorPersonId: c.minorPersonId, checkId: c.id, purpose: c.purpose, decision: out.decision });
  return { purpose: out.purpose, decision: out.decision, decidedAs: out.decidedAs, scopes: out.scopes, decidedAt: out.decidedAt.toISOString() };
}

/** The child's current choices, for their guardian: who decided each and when. */
export async function guardianConsents(userId: string, minorPersonId: string) {
  await requireProxy(userId, minorPersonId, "VIEW");
  const rows = await prisma.personConsent.findMany({ where: { personId: minorPersonId, purpose: { in: [...GUARDIAN_PURPOSES] as PersonConsentPurpose[] }, status: { in: ["ACTIVE", "LAPSED"] } }, orderBy: { decidedAt: "desc" } });
  return Object.fromEntries(GUARDIAN_PURPOSES.map((purpose) => {
    const r = rows.find((x) => x.purpose === purpose);
    return [purpose, r ? { decision: r.status === "LAPSED" ? "LAPSED" : r.decision, decidedAs: r.decidedAs, scopes: r.scopes, decidedAt: r.decidedAt.toISOString() } : null];
  }));
}
