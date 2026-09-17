import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auth/audit";
import { type ActorMemberships } from "@/lib/auth/tenantContext";
import { requirePlatform } from "./authz";
import { transitionSubscription } from "@/lib/commercial/subscriptions";

/**
 * Phase D4 — the dunning service boundary.
 *
 * This is NOT a scheduler and NOT embedded in a request route's hot path. It is
 * an explicit, idempotent, bounded, tenant-safe service that a future job
 * runner, an administrator, or a test can call. This codebase has no cron, so
 * automated scheduling is deliberately NOT claimed; when scheduling exists it
 * calls this same function.
 *
 * Dunning advances a subscription at most ONE stage per run (modelling a daily
 * job), never suspending on the first failure:
 *   ACTIVE  --(an invoice is past its due date and unpaid)-->  PAST_DUE
 *   PAST_DUE --(still unpaid)-->                               GRACE   (7-day window, set by D2)
 *   GRACE   --(grace window elapsed)-->                        SUSPENDED
 *
 * Payment FAILURE is separated from commercial SUSPENSION. Suspension changes
 * commercial entitlements per D2 only; it never revokes safety-critical clinical
 * access, which remains governed by C4 authorization. All transitions go through
 * the D2 lifecycle service, so commercial state stays centralized and audited.
 */

export interface DunningResult {
  scanned: number;
  transitioned: { organizationId: string; from: string; to: string }[];
}

export async function processBillingDunning(m: ActorMemberships, opts?: { now?: Date; limit?: number }): Promise<DunningResult> {
  requirePlatform(m);
  const now = opts?.now ?? new Date();
  const limit = Math.min(opts?.limit ?? 500, 2000);
  const transitioned: DunningResult["transitioned"] = [];

  const subs = await prisma.organizationSubscription.findMany({
    where: { status: { in: ["ACTIVE", "PAST_DUE", "GRACE"] } },
    select: { organizationId: true, status: true, gracePeriodEndsAt: true },
    take: limit,
  });

  for (const sub of subs) {
    let to: "PAST_DUE" | "GRACE" | "SUSPENDED" | null = null;

    if (sub.status === "GRACE") {
      // Grace elapsed -> suspend (one step). Lazy: derived from the timestamp.
      if (sub.gracePeriodEndsAt && sub.gracePeriodEndsAt <= now) to = "SUSPENDED";
    } else {
      // ACTIVE / PAST_DUE: is there an overdue, unpaid invoice?
      const overdue = await prisma.billingInvoice.findFirst({
        where: {
          organizationId: sub.organizationId,
          status: { in: ["OPEN", "PARTIALLY_PAID", "PAST_DUE"] },
          dueAt: { lt: now },
        },
        select: { id: true },
      });
      if (overdue) to = sub.status === "ACTIVE" ? "PAST_DUE" : "GRACE";
    }

    if (!to) continue;
    try {
      await transitionSubscription(m, sub.organizationId, to, "dunning");
      transitioned.push({ organizationId: sub.organizationId, from: sub.status, to });
    } catch {
      // A concurrent transition already moved it; dunning is idempotent — skip.
    }
  }

  if (transitioned.length) {
    await recordAuditEvent("commercial.billing.dunningRun", m.userId, { count: transitioned.length });
  }
  return { scanned: subs.length, transitioned };
}
