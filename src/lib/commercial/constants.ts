import type { SubscriptionStatus } from "@prisma/client";

/**
 * Phase D2 — subscription lifecycle rules.
 *
 * Transitions are an explicit allow-list; a transition not listed is refused by
 * the lifecycle service. This is separate from the D1 tenant lifecycle
 * (OrganizationStatus) — a tenant can be ACTIVE while its subscription is
 * PAST_DUE. See docs/enterprise/subscription-lifecycle.md.
 */
export const SUBSCRIPTION_TRANSITIONS: Record<SubscriptionStatus, SubscriptionStatus[]> = {
  TRIAL: ["ACTIVE", "PAST_DUE", "SUSPENDED", "CANCELLED", "EXPIRED"],
  ACTIVE: ["PAST_DUE", "SUSPENDED", "CANCELLED"],
  PAST_DUE: ["ACTIVE", "GRACE", "SUSPENDED", "CANCELLED"],
  GRACE: ["ACTIVE", "SUSPENDED", "CANCELLED", "EXPIRED"],
  SUSPENDED: ["ACTIVE", "CANCELLED", "EXPIRED"],
  // A cancelled subscription can be reinstated (ACTIVE) or reach its end (EXPIRED).
  CANCELLED: ["ACTIVE", "EXPIRED"],
  // An expired subscription is reinstated by assigning a plan again (-> ACTIVE).
  EXPIRED: ["ACTIVE"],
};

export function canTransitionSubscription(from: SubscriptionStatus, to: SubscriptionStatus): boolean {
  return SUBSCRIPTION_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * States in which the plan's entitlements are ENABLED. In TRIAL/ACTIVE the
 * organization has full access; PAST_DUE and GRACE are soft states before
 * suspension where access is deliberately preserved (a payment hiccup must not
 * instantly cut a hospital off). SUSPENDED / CANCELLED / EXPIRED disable premium
 * FEATURE access — but never delete data, and never gate safety-critical
 * clinical access (that is governed by C4 authorization, not commercial state).
 */
const ACTIVE_STATES: SubscriptionStatus[] = ["TRIAL", "ACTIVE", "PAST_DUE", "GRACE"];

export function isCommercialActive(status: SubscriptionStatus): boolean {
  return ACTIVE_STATES.includes(status);
}
