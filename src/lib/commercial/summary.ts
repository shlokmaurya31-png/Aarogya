import { prisma } from "@/lib/db";
import { assertOrganizationAccess, type ActorMemberships } from "@/lib/auth/tenantContext";
import { ENTITLEMENTS } from "./registry";
import { evaluateEntitlement, deriveCommercialState } from "./evaluator";
import { getSubscriptionRaw } from "./subscriptions";

/**
 * Phase D2 — the commercial read model for the control plane.
 *
 * Tenant-scoped: `organizationId` must be the D1-resolved organization, and
 * assertOrganizationAccess re-checks the caller has standing in it, so an
 * org/facility admin can only read THEIR OWN commercial state. Usage is derived
 * from canonical domain data (facilities, memberships), never from a counter
 * that could drift.
 */

/** Canonical usage counters (derived, not maintained). */
export async function getUsage(organizationId: string) {
  const [activeFacilities, users] = await Promise.all([
    prisma.facility.count({ where: { organizationId, status: { not: "DEACTIVATED" } } }),
    prisma.organizationMembership.count({ where: { organizationId, status: "ACTIVE" } }),
  ]);
  return { max_facilities: activeFacilities, max_users: users } as Record<string, number>;
}

export async function getCommercialSummary(m: ActorMemberships, organizationId: string) {
  assertOrganizationAccess(m, organizationId);
  const now = new Date();

  const sub = await getSubscriptionRaw(organizationId);
  const commercial = deriveCommercialState(sub, now);
  const usage = await getUsage(organizationId);

  const entitlements = [];
  for (const spec of ENTITLEMENTS) {
    const r = await evaluateEntitlement({ organizationId, key: spec.key, now });
    entitlements.push({
      key: spec.key,
      name: spec.name,
      type: spec.type,
      scope: spec.scope,
      allowed: r.allowed,
      value: r.value,
      limit: r.limit,
      unlimited: r.unlimited,
      source: r.source,
      usage: spec.type === "LIMIT" ? usage[spec.key] ?? null : null,
    });
  }

  const orgOverrides = await prisma.organizationEntitlementOverride.findMany({
    where: { organizationId },
    include: { entitlement: { select: { key: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });

  return {
    // Whether THIS caller may operate the commercial controls (platform only).
    // Lets the UI hide platform-only actions from ordinary facility/org admins;
    // the server still enforces it regardless of what the UI renders.
    canManage: m.isPlatformAdmin,
    subscription: sub && {
      status: sub.status,
      planCode: sub.plan.code,
      planName: sub.plan.name,
      planVersion: sub.plan.version,
      isDefault: sub.isDefault,
      billingInterval: sub.billingInterval,
      trialEndsAt: sub.trialEndsAt,
      currentPeriodEnd: sub.currentPeriodEnd,
      gracePeriodEndsAt: sub.gracePeriodEndsAt,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    },
    commercialActive: commercial.active,
    commercialReason: commercial.reason ?? null,
    entitlements,
    overrides: orgOverrides.map((o) => ({
      key: o.entitlement.key, name: o.entitlement.name,
      boolValue: o.boolValue, numberValue: o.numberValue, unlimited: o.unlimited,
      reason: o.reason, expiresAt: o.expiresAt,
    })),
  };
}
