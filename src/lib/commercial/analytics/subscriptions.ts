import { prisma } from "@/lib/db";
import { type ActorMemberships } from "@/lib/auth/tenantContext";
import { requirePlatform } from "@/lib/billing/authz";
import { resolveCurrentPrice } from "@/lib/billing/pricing";
import { CurrencyBuckets, resolvePeriod } from "./shared";

/**
 * Phase D5 — subscription lifecycle analytics + MRR/ARR.
 *
 * MRR is deterministic here because D2/D3 model plan pricing per interval and D2
 * models subscription state. It is computed ONLY from COMMITTED recurring
 * subscriptions (ACTIVE/PAST_DUE/GRACE) with a resolvable PlanPrice, normalized to
 * a monthly figure (MONTHLY as-is, QUARTERLY/3, YEARLY/12), grouped by currency.
 * TRIAL (not yet paying) and terminal states are excluded. ARR = MRR × 12. This
 * is a normalized run-rate, NOT recognized accounting revenue.
 */

const COMMITTED_STATES = ["ACTIVE", "PAST_DUE", "GRACE"] as const;

function monthlyNormalizedMinor(amountMinor: number, interval: string): number | null {
  switch (interval) {
    case "MONTHLY": return amountMinor;
    case "QUARTERLY": return Math.round(amountMinor / 3);
    case "YEARLY": return Math.round(amountMinor / 12);
    default: return null; // NONE / unknown -> not part of run-rate
  }
}

export async function getMrrArr(m: ActorMemberships, opts?: { now?: Date }) {
  requirePlatform(m);
  const now = opts?.now ?? new Date();
  const subs = await prisma.organizationSubscription.findMany({
    where: { status: { in: [...COMMITTED_STATES] }, billingInterval: { not: "NONE" } },
    select: { planId: true, billingInterval: true },
  });
  const mrr = new CurrencyBuckets(); const arr = new CurrencyBuckets();
  let counted = 0;
  for (const s of subs) {
    const price = await resolveCurrentPrice(prisma, s.planId, s.billingInterval, now);
    if (!price) continue;
    const monthly = monthlyNormalizedMinor(price.amountMinor, s.billingInterval);
    if (monthly == null) continue;
    mrr.add(price.currency, monthly); arr.add(price.currency, monthly * 12); counted++;
  }
  return {
    definition: "MRR = sum of monthly-normalized current PlanPrice over committed (ACTIVE/PAST_DUE/GRACE) subscriptions; ARR = MRR × 12. Run-rate, not recognized revenue.",
    committedSubscriptions: counted,
    mrr: mrr.toArray(),
    arr: arr.toArray(),
  };
}

const LIFECYCLE_EVENTS: Record<string, string> = {
  "commercial.subscription.created": "new",
  "commercial.subscription.trialStarted": "trialStarted",
  "commercial.subscription.transitioned": "transitioned",
  "commercial.subscription.cancelled": "cancelled",
  "commercial.subscription.cancellationScheduled": "cancellationScheduled",
  "commercial.billing.subscriptionRenewed": "renewed",
};

/** Lifecycle counts in a bounded period, from canonical D2/D3 audit events. */
export async function getLifecycleAnalytics(m: ActorMemberships, opts?: { fromISO?: string; toISO?: string }) {
  requirePlatform(m);
  const period = resolvePeriod(opts?.fromISO, opts?.toISO);
  const rows = await prisma.auditEvent.groupBy({
    by: ["type"],
    where: { type: { in: Object.keys(LIFECYCLE_EVENTS) }, createdAt: { gte: period.from, lt: period.to } },
    _count: true,
  });
  const counts: Record<string, number> = {};
  for (const r of rows) counts[LIFECYCLE_EVENTS[r.type] ?? r.type] = r._count;
  // Transition targets (PAST_DUE/GRACE/SUSPENDED/ACTIVE) live in detail; surface the
  // transitioned total plus a note that per-target breakdown needs detail parsing.
  return {
    period: { from: period.from, to: period.to, days: period.days, timezone: "UTC" },
    counts,
  };
}
