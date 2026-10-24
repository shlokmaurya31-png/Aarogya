import { $Enums, type PersonConsentDecision, type PersonConsentPurpose, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError, ConflictError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { emitDomainEvent } from "@/lib/events/emit";
import { parseEnum } from "@/lib/enumValue";
import { requireOwnedPerson } from "./access";

/**
 * Phase 0 — choices the person makes about their own data. Only the person's
 * OWNER login decides (never staff, never a delegate). Append-only: a change
 * supersedes the current choice. PersonConsentDecided says which way, never
 * anything else.
 */
export const CONSENT_SCOPES: Record<string, readonly string[]> = { AI_TEXT_RETENTION: ["SAFETY_REVIEW"] };

export async function decidePersonConsent(input: { userId: string; purpose: string; decision: string; scopes?: string[] }) {
  const purpose = parseEnum($Enums.PersonConsentPurpose, input.purpose, "purpose");
  const decision = parseEnum($Enums.PersonConsentDecision, input.decision, "decision");
  // Scopes exist only where a purpose defines them (AI_TEXT_RETENTION: SAFETY_REVIEW), and only with a grant.
  const scopes = [...new Set(input.scopes ?? [])].sort();
  const allowedScopes = CONSENT_SCOPES[purpose] ?? [];
  if (scopes.some((x) => !allowedScopes.includes(x))) throw new BadRequestError(`Scopes for ${purpose}: ${allowedScopes.join(", ") || "none"}.`);
  if (decision === "DECLINED" && scopes.length) throw new BadRequestError("A declined choice has no scopes.");
  const personId = await requireOwnedPerson(input.userId);
  const result = await prisma.$transaction((tx) => recordPersonConsentTx(tx, { personId, userId: input.userId, purpose, decision, scopes }));
  if (result.changed) await recordAuditEvent("person.consent.decided", input.userId, { personId, purpose, decision });
  return { purpose, decision: result.consent.decision, scopes: result.consent.scopes, decidedAt: result.consent.decidedAt.toISOString() };
}

/**
 * A person's choice, inside the caller's transaction: the current one is
 * superseded, the new one recorded and logged, and PersonConsentDecided
 * emitted. No change if the same choice is already in force. Week 4c:
 * shared with revoke-all, which declines "share uploads" in its own transaction.
 */
export async function recordPersonConsentTx(tx: Prisma.TransactionClient, input: { personId: string; userId: string; purpose: PersonConsentPurpose; decision: PersonConsentDecision; scopes: string[]; guardianCheckId?: string }) {
  const { personId, purpose, decision, scopes } = input;
  const decidedAs = input.guardianCheckId ? "GUARDIAN" : "SELF";
  const current = await tx.personConsent.findFirst({ where: { personId, purpose, status: "ACTIVE" } });
  if (current?.decision === decision && current.decidedAs === decidedAs && [...current.scopes].sort().join() === scopes.join()) return { consent: current, changed: false };
  if (current) {
    const r = await tx.personConsent.updateMany({ where: { id: current.id, status: "ACTIVE" }, data: { status: "SUPERSEDED", supersededAt: new Date() } });
    if (r.count !== 1) throw new ConflictError("This choice changed concurrently. Refresh and try again.");
  }
  const consent = await tx.personConsent.create({ data: { personId, purpose, decision, scopes, decidedByUserId: input.userId, decidedAs, guardianCheckId: input.guardianCheckId ?? null } });
  await tx.personAccessLogEntry.create({ data: { personId, kind: "CONSENT_DECIDED", actorUserId: input.userId, detail: { consentId: consent.id, purpose, decision, decidedAs } } });
  await emitDomainEvent(tx, {
    type: "PersonConsentDecided", aggregateId: personId, personId, actorUserId: input.userId,
    payload: { personId, consentId: consent.id, purpose, decision, previous: current?.decision ?? "NONE", scopes: scopes as "SAFETY_REVIEW"[], decidedAs },
  });
  return { consent, changed: true };
}

export function assertDecision(value: unknown): "GRANTED" | "DECLINED" {
  if (value !== "GRANTED" && value !== "DECLINED") throw new BadRequestError("decision must be GRANTED or DECLINED.");
  return value;
}
