import type { BillingPaymentAttemptStatus, BillingPaymentStatus } from "@prisma/client";

/**
 * Phase D4 — explicit, provider-facing payment state machine.
 *
 * Provider callbacks are not ordered and not unique. These allow-lists make the
 * dangerous transitions impossible: a stale/duplicate event can never move a
 * SUCCEEDED payment back to PENDING/FAILED, nor a REFUNDED payment to SUCCEEDED,
 * nor a FAILED attempt to SUCCEEDED. Anything not listed is refused; the caller
 * then records the condition and routes it to reconciliation rather than
 * overwriting canonical state.
 */

const ATTEMPT_TRANSITIONS: Record<BillingPaymentAttemptStatus, BillingPaymentAttemptStatus[]> = {
  INITIATED: ["PENDING", "SUCCEEDED", "FAILED", "CANCELLED"],
  PENDING: ["SUCCEEDED", "FAILED", "CANCELLED"],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
};

const PAYMENT_TRANSITIONS: Record<BillingPaymentStatus, BillingPaymentStatus[]> = {
  SUCCEEDED: ["PARTIALLY_REFUNDED", "REFUNDED", "VOID"],
  PARTIALLY_REFUNDED: ["REFUNDED"],
  REFUNDED: [],
  VOID: [],
};

export function canTransitionAttempt(from: BillingPaymentAttemptStatus, to: BillingPaymentAttemptStatus): boolean {
  return ATTEMPT_TRANSITIONS[from]?.includes(to) ?? false;
}

export function canTransitionPayment(from: BillingPaymentStatus, to: BillingPaymentStatus): boolean {
  return PAYMENT_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isAttemptTerminal(s: BillingPaymentAttemptStatus): boolean {
  return ATTEMPT_TRANSITIONS[s].length === 0;
}

/** Map a normalized provider payment status to the attempt status it implies. */
export function attemptStatusForProvider(providerStatus: "succeeded" | "failed" | "pending"): BillingPaymentAttemptStatus {
  return providerStatus === "succeeded" ? "SUCCEEDED" : providerStatus === "failed" ? "FAILED" : "PENDING";
}
