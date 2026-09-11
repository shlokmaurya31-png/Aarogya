import { createHash } from "crypto";
import { prisma } from "@/lib/db";
import { type Db, type DataOrigin } from "./shared";

/**
 * Phase C1 — interoperability provenance.
 *
 * AuditEvent answers "what did Aarogya do?". This answers "where did this
 * clinical representation come from?". They are related but distinct, and
 * collapsing them would destroy the ability to tell locally authored data from
 * data that arrived through an exchange.
 *
 * Every field here is server-derived. Nothing in an external payload may set the
 * actor, the facility, or the origin classification.
 */

export interface ProvenanceInput {
  facilityId: string;
  patientId?: string | null;
  entityType: string;
  entityId?: string | null;
  direction: "OUTBOUND" | "INBOUND";
  dataOrigin: DataOrigin;
  sourceSystem: string;
  externalResourceType?: string | null;
  externalResourceId?: string | null;
  externalVersion?: string | null;
  exchangeId?: string | null;
  consentId?: string | null;
  externalIdentifierId?: string | null;
  actorUserId?: string | null;
  actorStaffId?: string | null;
  correlationId?: string | null;
  requestId?: string | null;
  payload?: unknown;
  payloadContentType?: string | null;
}

/**
 * Hash and size a payload instead of storing it. Keeping the bytes out of the
 * database avoids a second, uncontrolled copy of clinical data while still
 * allowing an exchange to be proven byte-identical later.
 */
export function hashPayload(payload: unknown): { hash: string; bytes: number } {
  const serialized = typeof payload === "string" ? payload : JSON.stringify(payload ?? null);
  return {
    hash: createHash("sha256").update(serialized).digest("hex"),
    bytes: Buffer.byteLength(serialized, "utf8"),
  };
}

export async function recordProvenance(db: Db, input: ProvenanceInput) {
  const payloadMeta = input.payload !== undefined ? hashPayload(input.payload) : null;
  return db.interopProvenance.create({
    data: {
      facilityId: input.facilityId,
      patientId: input.patientId ?? null,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      direction: input.direction,
      dataOrigin: input.dataOrigin,
      sourceSystem: input.sourceSystem,
      externalResourceType: input.externalResourceType ?? null,
      externalResourceId: input.externalResourceId ?? null,
      externalVersion: input.externalVersion ?? null,
      exchangeId: input.exchangeId ?? null,
      consentId: input.consentId ?? null,
      externalIdentifierId: input.externalIdentifierId ?? null,
      actorUserId: input.actorUserId ?? null,
      actorStaffId: input.actorStaffId ?? null,
      correlationId: input.correlationId ?? null,
      requestId: input.requestId ?? null,
      payloadHash: payloadMeta?.hash ?? null,
      payloadBytes: payloadMeta?.bytes ?? null,
      payloadContentType: input.payloadContentType ?? null,
    },
  });
}

/** Provenance chain for one canonical record, newest first. */
export async function getProvenanceFor(facilityId: string, entityType: string, entityId: string) {
  return prisma.interopProvenance.findMany({
    where: { facilityId, entityType, entityId },
    orderBy: { recordedAt: "desc" },
    take: 100,
  });
}
