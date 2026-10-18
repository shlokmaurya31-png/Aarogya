import { $Enums } from "@prisma/client";
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
export async function decidePersonConsent(input: { userId: string; purpose: string; decision: string }) {
  const purpose = parseEnum($Enums.PersonConsentPurpose, input.purpose, "purpose");
  const decision = parseEnum($Enums.PersonConsentDecision, input.decision, "decision");
  const personId = await requireOwnedPerson(input.userId);
  const result = await prisma.$transaction(async (tx) => {
    const current = await tx.personConsent.findFirst({ where: { personId, purpose, status: "ACTIVE" } });
    if (current?.decision === decision) return { consent: current, changed: false };
    if (current) {
      const r = await tx.personConsent.updateMany({ where: { id: current.id, status: "ACTIVE" }, data: { status: "SUPERSEDED", supersededAt: new Date() } });
      if (r.count !== 1) throw new ConflictError("This choice changed concurrently. Refresh and try again.");
    }
    const consent = await tx.personConsent.create({ data: { personId, purpose, decision, decidedByUserId: input.userId } });
    await tx.personAccessLogEntry.create({ data: { personId, kind: "CONSENT_DECIDED", actorUserId: input.userId, detail: { consentId: consent.id, purpose, decision } } });
    await emitDomainEvent(tx, {
      type: "PersonConsentDecided", aggregateId: personId, personId, actorUserId: input.userId,
      payload: { personId, consentId: consent.id, purpose, decision, previous: current?.decision ?? "NONE" },
    });
    return { consent, changed: true };
  });
  if (result.changed) await recordAuditEvent("person.consent.decided", input.userId, { personId, purpose, decision });
  return { purpose, decision: result.consent.decision, decidedAt: result.consent.decidedAt.toISOString() };
}

export function assertDecision(value: unknown): "GRANTED" | "DECLINED" {
  if (value !== "GRANTED" && value !== "DECLINED") throw new BadRequestError("decision must be GRANTED or DECLINED.");
  return value;
}
