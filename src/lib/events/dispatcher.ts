import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { getEventContract } from "./catalogue";
import { getConsumersFor, type DomainEventConsumer } from "./consumers";
import { classifyEventError, safeMessage, isDataIntegrityCode, DATA_ERROR_ATTEMPTS, type DomainEventEnvelope } from "./types";

/**
 * Phase D6 — the domain-event dispatcher.
 *
 * Claims eligible outbox events, delivers each to every registered consumer, and
 * records the outcome — with at-least-once delivery, idempotent consumers, bounded
 * retries with exponential backoff, dead-lettering of permanent failures, and
 * poison-event isolation. It is:
 *   - concurrency-safe: a batch is claimed with one UPDATE … FOR UPDATE SKIP
 *     LOCKED + a per-claim token, so two workers never own the same event, and
 *     events of one aggregate are delivered in insert (seq) order;
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

/** A claim left PROCESSING longer than this is assumed abandoned (worker crashed). */
export const STALE_CLAIM_MS = 5 * 60_000;
const MAX_ROUNDS = 50;

/**
 * Workflow spine §3.3 — one statement claims a batch:
 *   - FOR UPDATE SKIP LOCKED, so concurrent workers take disjoint batches;
 *   - per-aggregate ordering: an event is claimable only when no older (lower
 *     seq) event of the same aggregate is still PENDING, RETRY or PROCESSING;
 *   - ordered by seq (insert order), never occurredAt, which is identical for
 *     every event of one transaction.
 * A dead-lettered event no longer blocks its successors.
 */
async function claimBatch(token: string, now: Date, batchSize: number): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string; seq: bigint }[]>`
    UPDATE "DomainEventOutbox" o
    SET "status" = 'PROCESSING', "claimToken" = ${token}, "lastAttemptAt" = ${now},
        "attemptCount" = o."attemptCount" + 1, "updatedAt" = ${now}
    WHERE o."id" IN (
      SELECT c."id" FROM "DomainEventOutbox" c
      WHERE c."status" IN ('PENDING', 'RETRY')
        AND (c."nextAttemptAt" IS NULL OR c."nextAttemptAt" <= ${now})
        AND NOT EXISTS (
          SELECT 1 FROM "DomainEventOutbox" e
          WHERE e."aggregateType" = c."aggregateType" AND e."aggregateId" = c."aggregateId"
            AND e."seq" < c."seq" AND e."status" IN ('PENDING', 'RETRY', 'PROCESSING'))
      ORDER BY c."seq"
      FOR UPDATE SKIP LOCKED
      LIMIT ${batchSize})
    RETURNING o."id", o."seq"`;
  return rows.sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0)).map((r) => r.id);
}

/**
 * Return abandoned claims to RETRY (a worker died between claim and finalize).
 * The delivery ledger stops consumers that already processed it from running again.
 */
export async function reapStaleClaims(now: Date = new Date()): Promise<number> {
  const r = await prisma.domainEventOutbox.updateMany({
    where: { status: "PROCESSING", lastAttemptAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) } },
    data: { status: "RETRY", claimToken: null, nextAttemptAt: null },
  });
  return r.count;
}

export async function dispatchPendingDomainEvents(opts: DispatchOptions = {}): Promise<DispatchResult> {
  const now = opts.now ?? new Date();
  const batchSize = Math.min(Math.max(1, opts.batchSize ?? 50), 500);
  const deadline = Date.now() + (opts.maxDurationMs ?? 25_000);
  const res: DispatchResult = { claimed: 0, processed: 0, retried: 0, deadLettered: 0, skipped: 0 };
  await reapStaleClaims(now);

  // Claim and process in rounds, so a chain of events on one aggregate drains
  // in one call (each round can only take the head of every aggregate). A
  // claimed batch is always processed in full; the deadline is checked between
  // rounds, so nothing is left PROCESSING when the budget runs out.
  for (let round = 0; round < MAX_ROUNDS && Date.now() <= deadline; round++) {
    const token = randomUUID();
    const ids = await claimBatch(token, now, batchSize);
    if (ids.length === 0) break;
    res.claimed += ids.length;
    for (const id of ids) {
      const outcome = await processClaimed(id, token, now);
      if (outcome === "PROCESSED") res.processed++;
      else if (outcome === "RETRY") res.retried++;
      else if (outcome === "DEAD_LETTER") res.deadLettered++;
      else res.skipped++;
    }
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
    // A data-integrity error (missing parent, row gone) has a short budget.
    const budget = isDataIntegrityCode(code) ? Math.min(maxAttempts, DATA_ERROR_ATTEMPTS) : maxAttempts;
    const terminal = !retryable || attempts >= budget;
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
        : { status: "DEAD_LETTER" as const, claimToken: null, nextAttemptAt: null, lastErrorCode: code, lastErrorMessage: message };
  await prisma.domainEventOutbox.updateMany({ where: { id, claimToken: token, status: "PROCESSING" }, data });
  return status;
}
