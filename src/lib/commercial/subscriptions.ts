import { prisma } from "@/lib/db";
import { Prisma, type SubscriptionStatus, type BillingInterval } from "@prisma/client";
import { recordAuditEvent } from "@/lib/auth/audit";
import { BadRequestError, ForbiddenError } from "@/lib/auth/rbac";
import type { ActorMemberships } from "@/lib/auth/tenantContext";
import { canTransitionSubscription } from "./constants";

/**
 * Phase D2 — subscription lifecycle service. All mutations here are
 * PLATFORM-only (creating/transitioning/cancelling a subscription is a
 * commercial act, never something an organization administrator does to itself).
 * Effective dates are server-set; no client-supplied timestamp is ever trusted.
 */

type DbClient = Prisma.TransactionClient | typeof prisma;

const DEFAULT_TRIAL_DAYS = 14;

function requirePlatform(m: ActorMemberships) {
  if (!m.isPlatformAdmin) throw new ForbiddenError("commercial:platform:manage");
}

function addInterval(from: Date, interval: BillingInterval): Date | null {
  const d = new Date(from);
  switch (interval) {
    case "MONTHLY": d.setMonth(d.getMonth() + 1); return d;
    case "QUARTERLY": d.setMonth(d.getMonth() + 3); return d;
    case "YEARLY": d.setFullYear(d.getFullYear() + 1); return d;
    case "NONE": return null;
  }
}

/**
 * Snapshot a plan's entitlements onto a subscription. This is what makes a later
 * edit to the plan NOT silently change an existing subscriber: the evaluator
 * reads this snapshot, not the live plan. Idempotent (delete + re-create).
 */
export async function syncSubscriptionEntitlements(client: DbClient, subscriptionId: string, planId: string) {
  const planEntitlements = await client.planEntitlement.findMany({ where: { planId } });
  await client.subscriptionEntitlement.deleteMany({ where: { subscriptionId } });
  if (planEntitlements.length === 0) return;
  await client.subscriptionEntitlement.createMany({
    data: planEntitlements.map((pe) => ({
      subscriptionId,
      entitlementId: pe.entitlementId,
      boolValue: pe.boolValue,
      numberValue: pe.numberValue,
      unlimited: pe.unlimited,
    })),
  });
}

/**
 * Ensure an organization has a subscription, assigning the internal default
 * (grandfather) plan if it has none. Idempotent and tolerant: if the plan
 * catalogue has not been bootstrapped yet it is a no-op (the next bootstrap will
 * supply one). Used by the bootstrap and by tenant provisioning so a freshly
 * provisioned organization is commercially functional immediately.
 */
export async function ensureDefaultSubscription(client: DbClient, organizationId: string): Promise<void> {
  const existing = await client.organizationSubscription.findUnique({ where: { organizationId }, select: { id: true } });
  if (existing) return;
  const defaultPlan = await client.subscriptionPlan.findFirst({ where: { isDefault: true, status: "ACTIVE" } });
  if (!defaultPlan) return; // catalogue not bootstrapped yet
  const sub = await client.organizationSubscription.create({
    data: { organizationId, planId: defaultPlan.id, status: "ACTIVE", billingInterval: "NONE", isDefault: true, currentPeriodStart: new Date() },
  });
  await syncSubscriptionEntitlements(client, sub.id, defaultPlan.id);
}

export interface AssignPlanInput {
  organizationId: string;
  planCode: string;
  /** Start as a trial (server sets trial dates) instead of ACTIVE. */
  trial?: boolean;
  trialDays?: number;
  isDefault?: boolean;
}

/**
 * Assign (create or replace) an organization's subscription to a plan and
 * snapshot its entitlements. One subscription per organization (unique), so
 * concurrent calls converge to one row.
 */
export async function assignPlan(m: ActorMemberships, input: AssignPlanInput) {
  requirePlatform(m);
  const plan = await prisma.subscriptionPlan.findUnique({ where: { code: input.planCode } });
  if (!plan) throw new BadRequestError("No such plan.");
  if (plan.status === "RETIRED") throw new BadRequestError("This plan is retired and cannot be assigned.");
  const org = await prisma.organization.findUnique({ where: { id: input.organizationId }, select: { id: true } });
  if (!org) throw new BadRequestError("No such organization.");

  const now = new Date();
  const status: SubscriptionStatus = input.trial ? "TRIAL" : "ACTIVE";
  const trialEndsAt = input.trial ? new Date(now.getTime() + (input.trialDays ?? DEFAULT_TRIAL_DAYS) * 86_400_000) : null;
  const periodEnd = input.trial ? null : addInterval(now, plan.billingInterval);

  const sub = await prisma.$transaction(async (tx) => {
    const s = await tx.organizationSubscription.upsert({
      where: { organizationId: input.organizationId },
      update: {
        planId: plan.id, status, billingInterval: plan.billingInterval, isDefault: input.isDefault ?? false,
        trialStartedAt: input.trial ? now : null, trialEndsAt,
        currentPeriodStart: input.trial ? null : now, currentPeriodEnd: periodEnd,
        gracePeriodEndsAt: null, cancelAtPeriodEnd: false, cancelledAt: null, suspendedAt: null,
      },
      create: {
        organizationId: input.organizationId, planId: plan.id, status, billingInterval: plan.billingInterval,
        isDefault: input.isDefault ?? false,
        trialStartedAt: input.trial ? now : null, trialEndsAt,
        currentPeriodStart: input.trial ? null : now, currentPeriodEnd: periodEnd,
      },
    });
    await syncSubscriptionEntitlements(tx, s.id, plan.id);
    return s;
  });

  await recordAuditEvent(
    input.trial ? "commercial.subscription.trialStarted" : "commercial.subscription.created",
    m.userId,
    { planCode: plan.code, status, isDefault: input.isDefault ?? false },
    { organizationId: input.organizationId }
  );
  return sub;
}

/** Move an organization's subscription along a declared transition. Platform-only. */
export async function transitionSubscription(m: ActorMemberships, organizationId: string, to: SubscriptionStatus, reason?: string) {
  requirePlatform(m);
  const sub = await prisma.organizationSubscription.findUnique({ where: { organizationId } });
  if (!sub) throw new BadRequestError("Organization has no subscription.");
  if (sub.status === to) throw new BadRequestError(`Subscription is already ${to}.`);
  if (!canTransitionSubscription(sub.status, to)) throw new BadRequestError(`Cannot move a subscription from ${sub.status} to ${to}.`);

  const now = new Date();
  const updated = await prisma.organizationSubscription.update({
    where: { organizationId },
    data: {
      status: to,
      suspendedAt: to === "SUSPENDED" ? now : sub.suspendedAt,
      gracePeriodEndsAt: to === "GRACE" ? new Date(now.getTime() + 7 * 86_400_000) : sub.gracePeriodEndsAt,
    },
  });
  await recordAuditEvent("commercial.subscription.transitioned", m.userId, { from: sub.status, to, reason: reason ?? null }, { organizationId });
  return updated;
}

/** Cancel a subscription: at period end (keeps access until then) or immediately. */
export async function cancelSubscription(m: ActorMemberships, organizationId: string, opts: { immediate?: boolean; reason?: string }) {
  requirePlatform(m);
  const sub = await prisma.organizationSubscription.findUnique({ where: { organizationId } });
  if (!sub) throw new BadRequestError("Organization has no subscription.");

  const now = new Date();
  if (opts.immediate) {
    if (!canTransitionSubscription(sub.status, "CANCELLED")) throw new BadRequestError(`Cannot cancel a ${sub.status} subscription.`);
    const updated = await prisma.organizationSubscription.update({
      where: { organizationId },
      data: { status: "CANCELLED", cancelledAt: now, cancelAtPeriodEnd: false },
    });
    await recordAuditEvent("commercial.subscription.cancelled", m.userId, { immediate: true, reason: opts.reason ?? null }, { organizationId });
    return updated;
  }
  // Cancel at period end: keep the subscription usable until currentPeriodEnd.
  // Without a period boundary (grandfather/NONE-interval or trial subscriptions
  // carry no currentPeriodEnd) there is nothing for the lazy expiry to fire on, so
  // the flag would silently never take effect — require immediate cancellation.
  if (!sub.currentPeriodEnd) {
    throw new BadRequestError("This subscription has no active billing period; cancel immediately instead.");
  }
  const updated = await prisma.organizationSubscription.update({
    where: { organizationId },
    data: { cancelAtPeriodEnd: true, cancelledAt: now },
  });
  await recordAuditEvent("commercial.subscription.cancellationScheduled", m.userId, { atPeriodEnd: sub.currentPeriodEnd, reason: opts.reason ?? null }, { organizationId });
  return updated;
}

/** Read one organization's subscription with plan + snapshot (no auth here; callers gate). */
export async function getSubscriptionRaw(organizationId: string) {
  return prisma.organizationSubscription.findUnique({
    where: { organizationId },
    include: { plan: true, entitlements: { include: { entitlement: true } } },
  });
}
