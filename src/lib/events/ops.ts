import { prisma } from "@/lib/db";
import { NotFoundError } from "@/lib/auth/rbac";
import { assertOrganizationAccess, type ActorMemberships } from "@/lib/auth/tenantContext";
import { requirePlatformEvents } from "./authz";

/**
 * Phase D6 — event operations & observability (read layer).
 *
 * Platform operators get cross-tenant operational visibility (counts, oldest
 * pending, dead letters, per-type breakdown, delivery health). A tenant sees only
 * its OWN events' operational metadata. Event payloads are safe to surface by
 * construction (identifiers + minimal metadata; the emit guard forbids secrets and
 * PHI), but events are NOT a clinical/commercial data API — a patientId in a
 * payload grants no access to the patient record.
 */

// Documented health thresholds (see docs/platform/events/event-delivery.md).
const HEALTH = {
  oldestPendingWarnMs: 5 * 60_000, // pending event older than 5 min → attention
  oldestPendingCritMs: 60 * 60_000, // older than 1 h → critical
  deadLetterWarn: 1, // any dead letter → attention
  deadLetterCrit: 25,
};

function countsByStatus(rows: { status: string; _count: { _all: number } }[]): Record<string, number> {
  const out: Record<string, number> = { PENDING: 0, PROCESSING: 0, PROCESSED: 0, RETRY: 0, DEAD_LETTER: 0 };
  for (const r of rows) out[r.status] = r._count._all;
  return out;
}

export async function getEventMetrics(m: ActorMemberships, opts?: { now?: Date }) {
  requirePlatformEvents(m);
  const now = opts?.now ?? new Date();

  const [statusRows, typeRows, deliveryRows, oldestPending, processedSample] = await Promise.all([
    prisma.domainEventOutbox.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.domainEventOutbox.groupBy({ by: ["eventType"], _count: { _all: true } }),
    prisma.domainEventDelivery.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.domainEventOutbox.findFirst({
      where: { status: { in: ["PENDING", "RETRY"] } },
      orderBy: { occurredAt: "asc" },
      select: { occurredAt: true },
    }),
    // Bounded sample for average processing latency (recordedAt → processedAt).
    prisma.domainEventOutbox.findMany({
      where: { status: "PROCESSED", processedAt: { not: null } },
      orderBy: { processedAt: "desc" },
      take: 200,
      select: { recordedAt: true, processedAt: true },
    }),
  ]);

  const byStatus = countsByStatus(statusRows);
  const oldestPendingAgeMs = oldestPending ? Math.max(0, now.getTime() - oldestPending.occurredAt.getTime()) : 0;
  const latencies = processedSample
    .map((r) => (r.processedAt ? r.processedAt.getTime() - r.recordedAt.getTime() : 0))
    .filter((n) => n >= 0);
  const avgProcessingLatencyMs = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;

  const deadLetters = byStatus.DEAD_LETTER;
  let health: "HEALTHY" | "ATTENTION" | "CRITICAL" = "HEALTHY";
  if (deadLetters >= HEALTH.deadLetterCrit || oldestPendingAgeMs >= HEALTH.oldestPendingCritMs) health = "CRITICAL";
  else if (deadLetters >= HEALTH.deadLetterWarn || oldestPendingAgeMs >= HEALTH.oldestPendingWarnMs) health = "ATTENTION";

  return {
    byStatus,
    byType: Object.fromEntries(typeRows.map((r) => [r.eventType, r._count._all])),
    deliveriesByStatus: countsByStatus(deliveryRows),
    oldestPendingAgeMs,
    avgProcessingLatencyMs,
    deadLetters,
    health,
    thresholds: HEALTH,
  };
}

export interface EventFilter {
  status?: string;
  eventType?: string;
  organizationId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

export async function listEvents(m: ActorMemberships, filter: EventFilter = {}) {
  requirePlatformEvents(m);
  return prisma.domainEventOutbox.findMany({
    where: {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.eventType ? { eventType: filter.eventType } : {}),
      ...(filter.organizationId ? { organizationId: filter.organizationId } : {}),
      ...(filter.from || filter.to ? { occurredAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } } : {}),
    },
    orderBy: { occurredAt: "desc" },
    take: Math.min(filter.limit ?? 100, 500),
    select: eventSelect,
  });
}

export async function getEvent(m: ActorMemberships, eventId: string) {
  requirePlatformEvents(m);
  const evt = await prisma.domainEventOutbox.findUnique({
    where: { eventId },
    select: { ...eventSelect, deliveries: { select: { consumerName: true, status: true, attemptCount: true, processedAt: true, lastErrorCode: true, lastError: true } } },
  });
  if (!evt) throw new NotFoundError();
  return evt;
}

export async function listDeadLetters(m: ActorMemberships, opts?: { limit?: number }) {
  requirePlatformEvents(m);
  return prisma.domainEventOutbox.findMany({
    where: { status: "DEAD_LETTER" },
    orderBy: { updatedAt: "desc" },
    take: Math.min(opts?.limit ?? 100, 500),
    select: { ...eventSelect, deliveries: { where: { status: "DEAD_LETTER" }, select: { consumerName: true, attemptCount: true, lastErrorCode: true, lastError: true } } },
  });
}

/** Tenant-scoped: an organization's own events (operational metadata + safe payload). */
export async function listOrganizationEvents(m: ActorMemberships, organizationId: string, filter: Omit<EventFilter, "organizationId"> = {}) {
  assertOrganizationAccess(m, organizationId);
  return prisma.domainEventOutbox.findMany({
    where: {
      organizationId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.eventType ? { eventType: filter.eventType } : {}),
      ...(filter.from || filter.to ? { occurredAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } } : {}),
    },
    orderBy: { occurredAt: "desc" },
    take: Math.min(filter.limit ?? 100, 200),
    select: eventSelect,
  });
}

const eventSelect = {
  eventId: true,
  eventType: true,
  eventVersion: true,
  aggregateType: true,
  aggregateId: true,
  organizationId: true,
  facilityId: true,
  correlationId: true,
  causationId: true,
  status: true,
  attemptCount: true,
  occurredAt: true,
  recordedAt: true,
  processedAt: true,
  nextAttemptAt: true,
  lastErrorCode: true,
  lastErrorMessage: true,
  payload: true,
} as const;
