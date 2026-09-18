import { z } from "zod";
import type { Prisma } from "@prisma/client";

/**
 * Phase D6 — domain-event foundation: shared types.
 *
 * A DomainEvent is a fact emitted FROM a canonical state change ("PaymentReceived"),
 * distinct from an AuditEvent which records WHO did what. Events are written to the
 * transactional outbox in the SAME database transaction as the mutation they
 * describe (see emit.ts), so they can never be lost when the write commits nor exist
 * when it rolls back. Canonical state stays in the domain tables; events are never
 * the source of truth (no event sourcing).
 */

/** A transaction client OR the global prisma client — events are emitted in-tx. */
export type EventTxClient = Prisma.TransactionClient | { domainEventOutbox: { create: (args: unknown) => unknown } };

/** Outbox lifecycle. Stored as TEXT; values enforced here, not by a DB enum. */
export const OUTBOX_STATUS = ["PENDING", "PROCESSING", "PROCESSED", "RETRY", "DEAD_LETTER"] as const;
export type OutboxStatus = (typeof OUTBOX_STATUS)[number];

/** Per-consumer delivery lifecycle. */
export const DELIVERY_STATUS = ["PENDING", "PROCESSED", "FAILED", "DEAD_LETTER"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUS)[number];

/** Canonical aggregate (entity) kinds an event can be about. */
export const AGGREGATE_TYPES = [
  "PATIENT",
  "APPOINTMENT",
  "ENCOUNTER",
  "ADMISSION",
  "MEDICATION_ORDER",
  "LAB_RESULT",
  "IMAGING_REPORT",
  "CONSENT",
  "SUBSCRIPTION",
  "INVOICE",
  "PAYMENT",
  "REFUND",
  "RECONCILIATION_EXCEPTION",
] as const;
export type AggregateType = (typeof AGGREGATE_TYPES)[number];

/**
 * Tenant scope of an event. ORGANIZATION/FACILITY events MUST carry an
 * organizationId (server-derived, never client-supplied); PLATFORM events are
 * explicitly cross-tenant operational facts and carry none.
 */
export type EventScope = "ORGANIZATION" | "FACILITY" | "PLATFORM";

/**
 * Data-sensitivity classification. No event payload ever carries secrets, card
 * data, tokens, or free clinical text — see catalogue.ts and sensitiveGuard.ts.
 *   LOW       — operational/commercial identifiers + amounts, no PHI.
 *   INTERNAL  — references a patient by id only (not the record contents).
 *   SENSITIVE — references a privacy-relevant act (consent) by id only.
 */
export type EventSensitivity = "LOW" | "INTERNAL" | "SENSITIVE";

/** A versioned event contract: one row of the catalogue. */
export interface EventContract<P extends z.ZodTypeAny = z.ZodTypeAny> {
  type: string;
  version: number;
  aggregateType: AggregateType;
  scope: EventScope;
  sensitivity: EventSensitivity;
  /** Human label of the domain service that produces this event. */
  producer: string;
  /** Zod schema for the payload — `.strict()` so unknown keys are rejected. */
  payload: P;
}

/** Input to emitDomainEvent — the caller supplies the business fields only. */
export interface EmitEventInput {
  type: string;
  version?: number; // defaults to the catalogue's current version for `type`
  aggregateId: string;
  organizationId?: string | null;
  facilityId?: string | null;
  actorUserId?: string | null;
  /** Groups events of one business operation; auto-generated if omitted. */
  correlationId?: string | null;
  /** The event/command that caused this one. */
  causationId?: string | null;
  /** Business-event time; defaults to now. */
  occurredAt?: Date;
  payload: Record<string, unknown>;
}

/** The delivered shape a consumer receives (immutable business fields). */
export interface DomainEventEnvelope {
  eventId: string;
  eventType: string;
  eventVersion: number;
  aggregateType: string;
  aggregateId: string;
  organizationId: string | null;
  facilityId: string | null;
  actorUserId: string | null;
  correlationId: string;
  causationId: string | null;
  occurredAt: Date;
  payload: Record<string, unknown>;
}

/** Errors a consumer may throw to control retry classification. */
export class RetryableEventError extends Error {
  readonly retryable = true as const;
  code: string;
  constructor(message: string, code = "TRANSIENT") {
    super(message);
    this.name = "RetryableEventError";
    this.code = code;
  }
}
export class PermanentEventError extends Error {
  readonly retryable = false as const;
  code: string;
  constructor(message: string, code = "PERMANENT") {
    super(message);
    this.name = "PermanentEventError";
    this.code = code;
  }
}

/**
 * Classify an arbitrary thrown value. Explicit Permanent/Retryable markers win.
 * A validation/authorization/bad-request shaped error is permanent (retrying a
 * malformed or forbidden event never succeeds). Everything else is treated as a
 * transient failure and retried up to the event's maxAttempts, then dead-lettered.
 */
export function classifyEventError(err: unknown): { retryable: boolean; code: string; message: string } {
  if (err instanceof PermanentEventError) return { retryable: false, code: err.code, message: err.message };
  if (err instanceof RetryableEventError) return { retryable: true, code: err.code, message: err.message };
  const status = (err as { status?: number }).status;
  if (status === 400 || status === 401 || status === 403 || status === 422) {
    return { retryable: false, code: `HTTP_${status}`, message: safeMessage(err) };
  }
  return { retryable: true, code: "UNHANDLED", message: safeMessage(err) };
}

/** Never surface stack traces or payloads through error text. */
export function safeMessage(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.length > 500 ? m.slice(0, 500) : m;
}
