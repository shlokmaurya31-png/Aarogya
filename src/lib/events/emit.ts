import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { currentVersion, getEventContract } from "./catalogue";
import { assertNoSensitiveData } from "./sensitiveGuard";
import { PermanentEventError, type EmitEventInput } from "./types";

/**
 * Phase D6 — the single emission point for domain events.
 *
 * `emitDomainEvent` writes ONE outbox row using the supplied client, which should
 * be the SAME transaction client (`tx`) as the domain mutation. That is the entire
 * transactional-outbox guarantee: if the domain transaction commits, the event
 * exists; if it rolls back, the event does not. Passing the global prisma client
 * instead emits the event in its own transaction — only correct when there is no
 * enclosing domain write to bind to.
 *
 * Emission is validated up front (unknown type/version, bad payload, or a
 * sensitive key are PERMANENT programming errors, never persisted) and tenant
 * scope is enforced from server-derived context — an event never trusts a
 * client-supplied organizationId.
 */

// Mirrors recordAuditEvent's client typing: accepts the global prisma, a
// transaction client `tx`, or the DbClient union — so the same emit call works
// inside or outside a transaction (pass `tx` to bind to the domain write).
type EmitClient = Pick<typeof prisma, "domainEventOutbox">;

export interface EmittedEvent {
  eventId: string;
  correlationId: string;
}

export async function emitDomainEvent(client: EmitClient, input: EmitEventInput): Promise<EmittedEvent> {
  const version = input.version ?? currentVersion(input.type);
  if (version === undefined) {
    throw new PermanentEventError(`Unknown event type "${input.type}".`, "UNKNOWN_TYPE");
  }
  const c = getEventContract(input.type, version);
  if (!c) {
    throw new PermanentEventError(`Unknown event contract ${input.type}@${version}.`, "UNKNOWN_VERSION");
  }

  const parsed = c.payload.safeParse(input.payload);
  if (!parsed.success) {
    throw new PermanentEventError(`Invalid payload for ${input.type}@${version}: ${parsed.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ")}`, "SCHEMA_INVALID");
  }
  const payload = parsed.data as Record<string, unknown>;
  assertNoSensitiveData(payload);

  // Tenant scope is derived from the server-side context the caller threads in,
  // never from the payload. Organization/facility events must be tenant-anchored.
  const organizationId = input.organizationId ?? null;
  const facilityId = input.facilityId ?? null;
  if ((c.scope === "ORGANIZATION" || c.scope === "FACILITY") && !organizationId) {
    throw new PermanentEventError(`Event ${input.type} is ${c.scope}-scoped and requires an organizationId.`, "MISSING_TENANT");
  }
  if (c.scope === "FACILITY" && !facilityId) {
    throw new PermanentEventError(`Event ${input.type} is FACILITY-scoped and requires a facilityId.`, "MISSING_FACILITY");
  }

  const eventId = randomUUID();
  const correlationId = input.correlationId ?? eventId;
  const occurredAt = input.occurredAt ?? new Date();

  await client.domainEventOutbox.create({
    data: {
      eventId,
      eventType: c.type,
      eventVersion: c.version,
      aggregateType: c.aggregateType,
      aggregateId: input.aggregateId,
      organizationId: c.scope === "PLATFORM" ? null : organizationId,
      facilityId: c.scope === "PLATFORM" ? null : facilityId,
      actorUserId: input.actorUserId ?? null,
      correlationId,
      causationId: input.causationId ?? null,
      payload: JSON.parse(JSON.stringify(payload)),
      occurredAt,
      status: "PENDING",
    },
  });

  return { eventId, correlationId };
}
