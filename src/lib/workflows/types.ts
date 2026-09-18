import type { DomainEventEnvelope } from "@/lib/events/types";

/**
 * Phase D7 — workflow engine shared types & bounds.
 *
 * The engine orchestrates existing domain services in response to committed D6
 * domain events. It never owns canonical clinical/financial state and never gains
 * clinical authority. All status/category values live here as string unions
 * (stored as TEXT; enforced by state machines), matching the D5/D6 convention.
 */

// ── Lifecycle vocabularies ───────────────────────────────────────────────────
export const DEFINITION_STATUS = ["ACTIVE", "INACTIVE"] as const;
export const VERSION_STATUS = ["DRAFT", "PUBLISHED", "RETIRED"] as const;
export const INSTANCE_STATUS = ["RUNNABLE", "RUNNING", "WAITING", "COMPLETED", "FAILED", "CANCELLED"] as const;
export const STEP_STATUS = ["PENDING", "RUNNING", "WAITING", "COMPLETED", "SKIPPED", "FAILED"] as const;
export const STEP_TYPE = ["CONDITION", "ACTION", "TASK", "TIMER"] as const;
export const TASK_STATUS = ["OPEN", "IN_PROGRESS", "COMPLETED", "CANCELLED", "EXPIRED"] as const;
export const TIMER_STATUS = ["PENDING", "CLAIMED", "COMPLETED", "CANCELLED"] as const;

export type StepType = (typeof STEP_TYPE)[number];

/**
 * Failure classification (§16). Only TRANSIENT/TIMEOUT/CONFLICT/RATE_LIMIT are
 * retryable — VALIDATION/AUTHORIZATION/NOT_FOUND/PERMANENT are terminal (retrying a
 * malformed, forbidden, or policy-denied step never succeeds).
 */
export const FAILURE_CATEGORY = [
  "TRANSIENT", "TIMEOUT", "CONFLICT", "RATE_LIMIT",
  "VALIDATION", "AUTHORIZATION", "NOT_FOUND", "PERMANENT", "UNKNOWN",
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORY)[number];

const RETRYABLE: ReadonlySet<FailureCategory> = new Set(["TRANSIENT", "TIMEOUT", "CONFLICT", "RATE_LIMIT"]);
export const isRetryable = (c: FailureCategory): boolean => RETRYABLE.has(c);

// ── Conservative engine bounds (§30) ─────────────────────────────────────────
export const LIMITS = {
  MAX_STEPS: 20,
  MAX_CONDITION_DEPTH: 5,
  MAX_CONDITION_NODES: 40,
  MAX_IN_VALUES: 50,
  MAX_TIMER_SECONDS: 30 * 24 * 3600, // 30 days
  MAX_RETRIES: 8,
  MAX_INSTANCE_DEPTH: 5, // event→workflow→event chain depth (loop prevention, §31)
} as const;

/** Thrown by workflow actions/steps to control retry classification. */
export class WorkflowError extends Error {
  category: FailureCategory;
  constructor(message: string, category: FailureCategory = "UNKNOWN") {
    super(message);
    this.name = "WorkflowError";
    this.category = category;
  }
}

/** Classify an arbitrary thrown value into a failure category. */
export function classifyWorkflowError(err: unknown): { category: FailureCategory; message: string } {
  if (err instanceof WorkflowError) return { category: err.category, message: safeMessage(err) };
  // Honor explicit retryable markers from other layers (e.g. the D6 event system's
  // Permanent/Retryable errors): a permanent error must never be retried.
  const retryable = (err as { retryable?: boolean }).retryable;
  if (retryable === false) return { category: "PERMANENT", message: safeMessage(err) };
  if (retryable === true) return { category: "TRANSIENT", message: safeMessage(err) };
  const status = (err as { status?: number }).status;
  if (status === 400 || status === 422) return { category: "VALIDATION", message: safeMessage(err) };
  if (status === 401 || status === 403) return { category: "AUTHORIZATION", message: safeMessage(err) };
  if (status === 404) return { category: "NOT_FOUND", message: safeMessage(err) };
  if (status === 409) return { category: "CONFLICT", message: safeMessage(err) };
  if (status === 429) return { category: "RATE_LIMIT", message: safeMessage(err) };
  return { category: "UNKNOWN", message: safeMessage(err) };
}

export function safeMessage(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.length > 500 ? m.slice(0, 500) : m;
}

/**
 * The allow-listed context a condition may inspect (§7). Nothing else — no ORM, no
 * arbitrary tables, no secrets, no PHI beyond what the (already-minimized) event
 * payload carries.
 */
export interface WorkflowContext {
  event: {
    type: string;
    version: number;
    aggregateType: string;
    aggregateId: string;
    organizationId: string | null;
    facilityId: string | null;
    actor: string | null;
  };
  payload: Record<string, unknown>;
}

export function buildContext(e: DomainEventEnvelope): WorkflowContext {
  return {
    event: {
      type: e.eventType,
      version: e.eventVersion,
      aggregateType: e.aggregateType,
      aggregateId: e.aggregateId,
      organizationId: e.organizationId,
      facilityId: e.facilityId,
      actor: e.actorUserId,
    },
    payload: e.payload ?? {},
  };
}
