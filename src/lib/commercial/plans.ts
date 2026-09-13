import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auth/audit";
import { BadRequestError, ForbiddenError, NotFoundError } from "@/lib/auth/rbac";
import type { ActorMemberships } from "@/lib/auth/tenantContext";
import type { SubscriptionPlanStatus, BillingInterval } from "@prisma/client";
import { getEntitlementSpec } from "./registry";

/**
 * Phase D2 — platform plan management. Plans are platform-controlled; an
 * organization administrator can never create or edit one. Editing a plan's
 * entitlements bumps `version` and is audited, and does NOT retroactively change
 * existing subscribers (they keep their SubscriptionEntitlement snapshot until an
 * explicit re-assign), so plan history stays understandable.
 */

function requirePlatform(m: ActorMemberships) {
  if (!m.isPlatformAdmin) throw new ForbiddenError("commercial:platform:manage");
}

export async function listPlans() {
  return prisma.subscriptionPlan.findMany({
    orderBy: { createdAt: "asc" },
    include: { entitlements: { include: { entitlement: true } } },
  });
}

export async function createPlan(m: ActorMemberships, input: { code: string; name: string; description?: string; billingInterval?: BillingInterval }) {
  requirePlatform(m);
  const code = input.code.trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(code)) throw new BadRequestError("Plan code must be lowercase alphanumeric with dashes.");
  const existing = await prisma.subscriptionPlan.findUnique({ where: { code }, select: { id: true } });
  if (existing) throw new BadRequestError("A plan with this code already exists.");
  const plan = await prisma.subscriptionPlan.create({
    data: { code, name: input.name.trim(), description: input.description ?? null, billingInterval: input.billingInterval ?? "MONTHLY" },
  });
  await recordAuditEvent("commercial.plan.created", m.userId, { code, name: plan.name });
  return plan;
}

export async function updatePlan(m: ActorMemberships, planId: string, input: { name?: string; description?: string | null; status?: SubscriptionPlanStatus }) {
  requirePlatform(m);
  const plan = await prisma.subscriptionPlan.findUnique({ where: { id: planId } });
  if (!plan) throw new NotFoundError();
  const updated = await prisma.subscriptionPlan.update({
    where: { id: planId },
    data: { name: input.name?.trim(), description: input.description, status: input.status },
  });
  if (input.status && input.status !== plan.status) {
    await recordAuditEvent("commercial.plan.statusChanged", m.userId, { code: plan.code, from: plan.status, to: input.status });
  } else {
    await recordAuditEvent("commercial.plan.updated", m.userId, { code: plan.code });
  }
  return updated;
}

export async function setPlanEntitlement(m: ActorMemberships, planId: string, input: { key: string; boolValue?: boolean | null; numberValue?: number | null; unlimited?: boolean }) {
  requirePlatform(m);
  const spec = getEntitlementSpec(input.key);
  if (!spec) throw new BadRequestError(`Unknown entitlement: ${input.key}`);
  const plan = await prisma.subscriptionPlan.findUnique({ where: { id: planId }, select: { id: true, code: true } });
  if (!plan) throw new NotFoundError();
  const def = await prisma.entitlementDefinition.findUnique({ where: { key: input.key } });
  if (!def) throw new BadRequestError("Entitlement registry not bootstrapped.");

  await prisma.$transaction(async (tx) => {
    await tx.planEntitlement.upsert({
      where: { planId_entitlementId: { planId, entitlementId: def.id } },
      update: { boolValue: input.boolValue ?? null, numberValue: input.numberValue ?? null, unlimited: input.unlimited ?? false },
      create: { planId, entitlementId: def.id, boolValue: input.boolValue ?? null, numberValue: input.numberValue ?? null, unlimited: input.unlimited ?? false },
    });
    // Bump the plan version so the change is historically attributable. Existing
    // subscribers are unaffected (their snapshot is not touched here).
    await tx.subscriptionPlan.update({ where: { id: planId }, data: { version: { increment: 1 } } });
  });
  await recordAuditEvent("commercial.planEntitlement.changed", m.userId, { plan: plan.code, key: input.key });
}
