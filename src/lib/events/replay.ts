import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { NotFoundError, BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { type ActorMemberships } from "@/lib/auth/tenantContext";
import { requirePlatformEvents } from "./authz";

/**
 * Phase D6 — controlled event replay & dead-letter retry.
 *
 * Replay is PLATFORM-only, explicit, audited, bounded and idempotent. It creates
 * a new PROCESSING ATTEMPT for an existing event — it NEVER rewrites the immutable
 * event (type, version, aggregate, organization, payload, occurredAt are never
 * touched) and NEVER mutates canonical domain state. It resets the targeted
 * delivery rows so consumers re-run; because consumers are idempotent, replaying a
 * delivered event does not double-apply its effect. Concurrent replays converge on
 * the same PENDING/RETRY state and the dispatcher's guarded claim ensures a single
 * effective run.
 */

async function loadOrThrow(eventId: string) {
  const evt = await prisma.domainEventOutbox.findUnique({ where: { eventId }, select: { eventId: true, eventType: true, status: true, organizationId: true } });
  if (!evt) throw new NotFoundError();
  return evt;
}

/**
 * Re-enqueue an event for (re)delivery. If `consumerName` is given, only that
 * consumer's delivery is reset; otherwise every existing delivery for the event is
 * reset. The event itself is left immutable.
 */
export async function replayEvent(m: ActorMemberships, eventId: string, opts?: { consumerName?: string; reason?: string }) {
  requirePlatformEvents(m);
  const evt = await loadOrThrow(eventId);

  const result = await prisma.$transaction(async (tx) => {
    const reset = await tx.domainEventDelivery.updateMany({
      where: { eventId, ...(opts?.consumerName ? { consumerName: opts.consumerName } : {}) },
      data: { status: "PENDING", processedAt: null, lastError: null, lastErrorCode: null },
    });
    // Explicit replay is the only sanctioned PROCESSED/DEAD_LETTER → RETRY move.
    await tx.domainEventOutbox.update({
      where: { eventId },
      data: { status: "RETRY", nextAttemptAt: new Date(), claimToken: null, attemptCount: 0, lastErrorCode: null, lastErrorMessage: null, processedAt: null },
    });
    await recordAuditEvent("platform.event.replayed", m.userId, { eventId, eventType: evt.eventType, consumerName: opts?.consumerName ?? "*", deliveriesReset: reset.count, reason: opts?.reason ?? null }, { organizationId: evt.organizationId ?? undefined }, tx);
    return { deliveriesReset: reset.count };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20000, maxWait: 10000 });

  return { eventId, ...result };
}

/** Retry a dead-lettered event after the underlying cause has been corrected. */
export async function retryDeadLetter(m: ActorMemberships, eventId: string, opts?: { reason?: string }) {
  requirePlatformEvents(m);
  const evt = await loadOrThrow(eventId);
  if (evt.status !== "DEAD_LETTER") throw new BadRequestError("Only a dead-lettered event can be retried.");

  const result = await prisma.$transaction(async (tx) => {
    const reset = await tx.domainEventDelivery.updateMany({
      where: { eventId, status: { in: ["DEAD_LETTER", "FAILED"] } },
      data: { status: "PENDING", attemptCount: 0, processedAt: null, lastError: null, lastErrorCode: null },
    });
    await tx.domainEventOutbox.update({
      where: { eventId },
      data: { status: "RETRY", nextAttemptAt: new Date(), claimToken: null, attemptCount: 0, lastErrorCode: null, lastErrorMessage: null },
    });
    await recordAuditEvent("platform.event.deadLetterRetried", m.userId, { eventId, eventType: evt.eventType, deliveriesReset: reset.count, reason: opts?.reason ?? null }, { organizationId: evt.organizationId ?? undefined }, tx);
    return { deliveriesReset: reset.count };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20000, maxWait: 10000 });

  return { eventId, ...result };
}
