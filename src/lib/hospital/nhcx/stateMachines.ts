/**
 * Phase C5 — claim exchange state machines.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THREE SEPARATE MACHINES, DELIBERATELY
 *
 *   1. Claim.status          — canonical BILLING truth (Phase 5, untouched)
 *   2. ClaimSubmission.status — one submission ATTEMPT
 *   3. NhcxExchange.protocolState — what the external network said
 *
 * They diverge legitimately and constantly. A claim can be locally corrected
 * with no exchange at all; an exchange can fail without the claim changing
 * state; a payer can reject a submission while the claim stays open for
 * resubmission. Collapsing them would make "we never sent it" indistinguishable
 * from "they rejected it" — the same distinction C3 preserved between local
 * exchange state and ABDM protocol state.
 *
 * The canonical Claim machine already exists in billing/claims.ts and is NOT
 * redefined here. This file maps onto it rather than replacing it.
 * ════════════════════════════════════════════════════════════════════════════
 */

// ── Submission attempt ──────────────────────────────────────────────────────

export const SUBMISSION_STATUSES = [
  "DRAFT",
  "READY",
  "SUBMITTED",
  "ACKNOWLEDGED",
  "ACCEPTED",
  "REJECTED",
  "FAILED",
  /** Replaced by a later version. Terminal. */
  "SUPERSEDED",
] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

export const SUBMISSION_TRANSITIONS: Record<SubmissionStatus, SubmissionStatus[]> = {
  DRAFT: ["READY", "SUPERSEDED"],
  // READY -> FAILED covers a local pre-flight failure that never left the building.
  READY: ["SUBMITTED", "FAILED", "SUPERSEDED"],
  SUBMITTED: ["ACKNOWLEDGED", "REJECTED", "FAILED"],
  ACKNOWLEDGED: ["ACCEPTED", "REJECTED"],
  // A failed attempt may be retried; a rejected one needs a NEW version, which
  // is why REJECTED does not lead back to SUBMITTED.
  FAILED: ["SUBMITTED", "SUPERSEDED"],
  ACCEPTED: [],
  REJECTED: ["SUPERSEDED"],
  SUPERSEDED: [],
};

// ── Protocol exchange ───────────────────────────────────────────────────────

export const PROTOCOL_STATES = [
  "NOT_SUBMITTED",
  "SUBMITTED",
  "ACKNOWLEDGED",
  "RESPONDED",
  "FAILED",
  "CANCELLED",
] as const;
export type ProtocolState = (typeof PROTOCOL_STATES)[number];

export const PROTOCOL_TRANSITIONS: Record<ProtocolState, ProtocolState[]> = {
  NOT_SUBMITTED: ["SUBMITTED", "CANCELLED", "FAILED"],
  // ACKNOWLEDGED may be skipped: an exchange can answer directly, and requiring
  // the intermediate step would silently drop real responses.
  SUBMITTED: ["ACKNOWLEDGED", "RESPONDED", "FAILED"],
  ACKNOWLEDGED: ["RESPONDED", "FAILED"],
  FAILED: ["SUBMITTED", "CANCELLED"],
  RESPONDED: [],
  CANCELLED: [],
};

// ── Query / clarification ───────────────────────────────────────────────────

export const QUERY_STATUSES = [
  "RECEIVED",
  "UNDER_REVIEW",
  "RESPONSE_DRAFT",
  "RESPONSE_SUBMITTED",
  "ACKNOWLEDGED",
  "RESOLVED",
  "CLOSED",
] as const;
export type QueryStatus = (typeof QUERY_STATUSES)[number];

export const QUERY_TRANSITIONS: Record<QueryStatus, QueryStatus[]> = {
  RECEIVED: ["UNDER_REVIEW", "CLOSED"],
  UNDER_REVIEW: ["RESPONSE_DRAFT", "CLOSED"],
  RESPONSE_DRAFT: ["RESPONSE_SUBMITTED", "CLOSED"],
  RESPONSE_SUBMITTED: ["ACKNOWLEDGED", "RESOLVED"],
  ACKNOWLEDGED: ["RESOLVED"],
  RESOLVED: [],
  CLOSED: [],
};

// ── Settlement ──────────────────────────────────────────────────────────────

export const SETTLEMENT_STATUSES = ["NOTIFIED", "RECONCILED", "DISPUTED", "REJECTED"] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

export const SETTLEMENT_TRANSITIONS: Record<SettlementStatus, SettlementStatus[]> = {
  NOTIFIED: ["RECONCILED", "DISPUTED", "REJECTED"],
  DISPUTED: ["RECONCILED", "REJECTED"],
  // Reconciled is terminal: undoing it would silently move money.
  RECONCILED: [],
  REJECTED: [],
};

// ── Reconciliation exceptions ───────────────────────────────────────────────

export const EXCEPTION_STATUSES = ["OPEN", "ACKNOWLEDGED", "RESOLVED", "DISMISSED"] as const;

export const EXCEPTION_TRANSITIONS: Record<string, string[]> = {
  OPEN: ["ACKNOWLEDGED", "RESOLVED", "DISMISSED"],
  ACKNOWLEDGED: ["RESOLVED", "DISMISSED"],
  RESOLVED: [],
  DISMISSED: [],
};

export const EXCEPTION_TYPES = [
  "AMOUNT_MISMATCH",
  "MISSING_SETTLEMENT",
  "DUPLICATE_SETTLEMENT",
  "OVERPAYMENT",
  "UNDERPAYMENT",
  "ORPHAN_EXTERNAL_REFERENCE",
  "UNMATCHED_CLAIM",
  "STALE_EXTERNAL_STATUS",
] as const;

// ── Generic guard ───────────────────────────────────────────────────────────

export function isTransitionAllowed(
  map: Record<string, string[]>,
  from: string | null | undefined,
  to: string
): boolean {
  const current = from ?? Object.keys(map)[0];
  return map[current]?.includes(to) ?? false;
}

export function isTerminal(map: Record<string, string[]>, state: string): boolean {
  return (map[state]?.length ?? 0) === 0;
}

/**
 * How a submission outcome maps onto the CANONICAL claim status.
 *
 * Returns null when the submission implies nothing about the billing record —
 * which is most of the time. Forcing a canonical transition on every protocol
 * event would fight the Phase 5 state machine, so this only speaks when the
 * outcome genuinely settles the claim's billing state.
 *
 * Canonical ClaimStatus (Phase 5, unchanged):
 *   DRAFT SUBMITTED UNDER_REVIEW APPROVED PARTIALLY_APPROVED REJECTED SETTLED CLOSED
 *
 * Note what is absent from the canonical enum: ACKNOWLEDGED, QUERY and
 * RESPONSE_SUBMITTED. Those are protocol concerns and live on the submission
 * and query records instead of being bolted onto billing.
 */
export function canonicalStatusForSubmission(
  submissionStatus: SubmissionStatus
): string | null {
  switch (submissionStatus) {
    case "SUBMITTED":
      return "SUBMITTED";
    case "ACKNOWLEDGED":
      // The payer has it and is looking at it.
      return "UNDER_REVIEW";
    case "REJECTED":
      return "REJECTED";
    // DRAFT/READY/ACCEPTED/FAILED/SUPERSEDED say nothing about billing state:
    // ACCEPTED means "accepted for adjudication", not "approved".
    default:
      return null;
  }
}

/** Map an external adjudication outcome onto the canonical claim status. */
export function canonicalStatusForAdjudication(outcome: string): string | null {
  switch (outcome) {
    case "APPROVED": return "APPROVED";
    case "PARTIALLY_APPROVED": return "PARTIALLY_APPROVED";
    case "REJECTED": return "REJECTED";
    // PENDING and QUERY leave the claim under review; they are not decisions.
    case "PENDING":
    case "QUERY": return "UNDER_REVIEW";
    default: return null;
  }
}
