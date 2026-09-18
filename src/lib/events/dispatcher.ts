import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { getEventContract } from "./catalogue";
import { getConsumersFor, type DomainEventConsumer } from "./consumers";
import { classifyEventError, safeMessage, type DomainEventEnvelope } from "./types";

/**
 * Phase D6 — the domain-event dispatcher.
 *
 * Claims eligible outbox events, delivers each to every registered consumer, and
 * records the outcome — with at-least-once delivery, idempotent consumers, bounded
 * retries with exponential backoff, dead-lettering of permanent failures, and
 * poison-event isolation. It is:
 *   - concurrency-safe: an event is claimed with a guarded conditional UPDATE +
 *     per-claim token, so two workers can never both own the same event (works on
 *     both SQLite and PostgreSQL without SELECT ... FOR UPDATE);
 *   - bounded: batchSize + maxDurationMs cap the work per invocation, so it can be
 *     driven by a scheduler, worker, CLI, or operational endpoint (D6 ships no
 *     daemon — correctness never depends on one running);
 *   - side-effect-free on the domain: it only advances event/delivery bookkeeping.
 */

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 3_600_000;

function backoffFrom(now: Date, attempt: number): Date {
  const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return new Date(now.getTime() + delay);
}

export interface DispatchOptions {
  batchSize?: number;
  maxDurationMs?: number;
  now?: Date;
}
export interface DispatchResult {
  claimed: number;
  processed: number;
  retried: number;
  deadLettered: number;
  skipped: number;
}

export async function dispatchPendingDomainEvents(opts: DispatchOptions = {}): Promise<DispatchResult> {
  const now = opts.now ?? new Date();
  const batchSize = Math.min(Math.max(1, opts.batchSize ?? 50), 500);
  const deadline = Date.now() + (opts.maxDurationMs ?? 25_000);
  const res: DispatchResult = { claimed: 0, processed: 0, retried: 0, deadLettered: 0, skipped: 0 };

  const candidates = await prisma.domainEventOutbox.findMany({
    where: { status: { in: ["PENDING", "RETRY"] }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
    orderBy: { occurredAt: "asc" },
    take: batchSize,
    select: { id: true },
  });

  for (const cand of candidates) {
    if (Date.now() > deadline) break;
    const token = randomUUID();
    // Guarded claim: only one worker's UPDATE matches the (still-eligible) row.
    const claim = await prisma.domainEventOutbox.updateMany({
      where: { id: cand.id, status: { in: ["PENDING", "RETRY"] }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
      data: { status: "PROCESSING", claimToken: token, lastAttemptAt: now, attemptCount: { increment: 1 } },
    });
    if (claim.count !== 1) {
      res.skipped++;
      continue;
    }
    res.claimed++;
    const outcome = await processClaimed(cand.id, token, now);
    if (outcome === "PROCESSED") res.processed++;
    else if (outcome === "RETRY") res.retried++;
    else if (outcome === "DEAD_LETTER") res.deadLettered++;
    else res.skipped++;
  }
  return res;
}

type Outcome = "PROCESSED" | "RETRY" | "DEAD_LETTER" | "SKIPPED";

async function processClaimed(id: string, token: string, now: Date): Promise<Outcome> {
  const evt = await prisma.domainEventOutbox.findUnique({ where: { id } });
  if (!evt || evt.claimToken !== token || evt.status !== "PROCESSING") return "SKIPPED";

  // Poison isolation: an event whose type/version is unknown, or whose payload no
  // longer satisfies its contract, can never be delivered — dead-letter it and
  // move on so it never blocks the queue for valid events.
  const contract = getEventContract(evt.eventType, evt.eventVersion);
  if (!contract) return finalize(id, token, now, "DEAD_LETTER", "SCHEMA_UNKNOWN", `No contract for ${evt.eventType}@${evt.eventVersion}`);
  const parsed = contract.payload.safeParse(evt.payload);
  if (!parsed.success) return finalize(id, token, now, "DEAD_LETTER", "SCHEMA_INVALID", "Event payload failed contract validation");

  const envelope: DomainEventEnvelope = {
    eventId: evt.eventId,
    eventType: evt.eventType,
    eventVersion: evt.eventVersion,
    aggregateType: evt.aggregateType,
    aggregateId: evt.aggregateId,
    organizationId: evt.organizationId,
    facilityId: evt.facilityId,
    actorUserId: evt.actorUserId,
    correlationId: evt.correlationId,
    causationId: evt.causationId,
    occurredAt: evt.occurredAt,
    payload: parsed.data as Record<string, unknown>,
  };

  let anyRetry = false;
  let anyDead = false;
  for (const consumer of getConsumersFor(evt.eventType)) {
    const d = await deliverToConsumer(evt.eventId, consumer, envelope, evt.maxAttempts, now);
    if (d === "RETRY") anyRetry = true;
    else if (d === "DEAD_LETTER") anyDead = true;
  }

  if (anyRetry) return finalize(id, token, now, "RETRY", null, null);
  if (anyDead) return finalize(id, token, now, "DEAD_LETTER", "CONSUMER_DEAD_LETTER", "One or more consumers permanently failed");
  return finalize(id, token, now, "PROCESSED", null, null);
}

type DeliveryOutcome = "PROCESSED" | "RETRY" | "DEAD_LETTER";

async function deliverToConsumer(
  eventId: string,
  consumer: DomainEventConsumer,
  envelope: DomainEventEnvelope,
  maxAttempts: number,
  now: Date,
): Promise<DeliveryOutcome> {
  // Ensure exactly one delivery row per (event, consumer) — the idempotency key.
  let delivery = await prisma.domainEventDelivery.findUnique({
    where: { eventId_consumerName: { eventId, consumerName: consumer.name } },
  });
  if (!delivery) {
    try {
      delivery = await prisma.domainEventDelivery.create({ data: { eventId, consumerName: consumer.name, status: "PENDING" } });
    } catch (err) {
      if ((err as { code?: string }).code !== "P2002") throw err;
      delivery = await prisma.domainEventDelivery.findUniqueOrThrow({
        where: { eventId_consumerName: { eventId, consumerName: consumer.name } },
      });
    }
  }
  // Already terminal: never re-run (at-least-once + idempotency == one effect).
  if (delivery.status === "PROCESSED") return "PROCESSED";
  if (delivery.status === "DEAD_LETTER") return "DEAD_LETTER";

  try {
    await consumer.handle(envelope);
    await prisma.domainEventDelivery.update({
      where: { id: delivery.id },
      data: { status: "PROCESSED", attemptCount: { increment: 1 }, processedAt: now, lastError: null, lastErrorCode: null },
    });
    return "PROCESSED";
  } catch (err) {
    const { retryable, code, message } = classifyEventError(err);
    const attempts = delivery.attemptCount + 1;
    const terminal = !retryable || attempts >= maxAttempts;
    await prisma.domainEventDelivery.update({
      where: { id: delivery.id },
      data: { status: terminal ? "DEAD_LETTER" : "FAILED", attemptCount: attempts, lastError: safeMessage(message), lastErrorCode: code },
    });
    return terminal ? "DEAD_LETTER" : "RETRY";
  }
}

/** Advance the outbox row, guarded by the claim token so only the owner writes. */
async function finalize(id: string, token: string, now: Date, status: Outcome, code: string | null, message: string | null): Promise<Outcome> {
  const attempt = (await prisma.domainEventOutbox.findUnique({ where: { id }, select: { attemptCount: true } }))?.attemptCount ?? 1;
  const data =
    status === "PROCESSED"
      ? { status, processedAt: now, claimToken: null, lastErrorCode: null, lastErrorMessage: null, nextAttemptAt: null }
      : status === "RETRY"
        ? { status, claimToken: null, nextAttemptAt: backoffFrom(now, attempt), lastErrorCode: code, lastErrorMessage: message }
        : { status: "DEAD_LETTER", claimToken: null, nextAttemptAt: null, lastErrorCode: code, lastErrorMessage: message };
  await prisma.domainEventOutbox.updateMany({ where: { id, claimToken: token, status: "PROCESSING" }, data });
  return status;
}
