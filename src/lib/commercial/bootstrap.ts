import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auth/audit";
import { ENTITLEMENTS, PLANS, DEFAULT_PLAN_CODE } from "./registry";
import { syncSubscriptionEntitlements } from "./subscriptions";

/**
 * Phase D2 — commercial bootstrap.
 *
 * Idempotently materialises the CODE registry (entitlement definitions + plans +
 * plan entitlements) into the database, and gives every organization that lacks
 * one an EXPLICIT commercial state. This is the documented bootstrap strategy
 * (docs/enterprise/commercial-model.md); it is called from prisma/seed.ts and is
 * safe to run once in production.
 *
 * Organizations that predate D2 are placed on the internal "aarogya-default"
 * grandfather plan (flagged isDefault everywhere), which preserves their pre-D2
 * access. This is deliberately NOT the sold "Enterprise" plan and never fabricates
 * a customer contract — it is an explicit, labelled default.
 */
export async function ensureCommercialBootstrap(client = prisma): Promise<{ orgsBootstrapped: number }> {
  // 1. Entitlement definitions (by stable key).
  for (const e of ENTITLEMENTS) {
    await client.entitlementDefinition.upsert({
      where: { key: e.key },
      update: {
        name: e.name, description: e.description, type: e.type, scope: e.scope,
        defaultBool: e.defaultBool ?? null, defaultNumber: e.defaultNumber ?? null,
        defaultUnlimited: e.defaultUnlimited ?? false, active: true,
      },
      create: {
        key: e.key, name: e.name, description: e.description, type: e.type, scope: e.scope,
        defaultBool: e.defaultBool ?? null, defaultNumber: e.defaultNumber ?? null,
        defaultUnlimited: e.defaultUnlimited ?? false,
      },
    });
  }

  const defs = await client.entitlementDefinition.findMany();
  const defByKey = new Map(defs.map((d) => [d.key, d]));

  // 2. Plans + plan entitlements (by code / planId+entitlementId).
  for (const p of PLANS) {
    const plan = await client.subscriptionPlan.upsert({
      where: { code: p.code },
      update: { name: p.name, description: p.description, billingInterval: p.billingInterval, isDefault: !!p.isDefault, status: "ACTIVE" },
      create: { code: p.code, name: p.name, description: p.description, billingInterval: p.billingInterval, isDefault: !!p.isDefault },
    });
    for (const pe of p.entitlements) {
      const def = defByKey.get(pe.key);
      if (!def) continue;
      await client.planEntitlement.upsert({
        where: { planId_entitlementId: { planId: plan.id, entitlementId: def.id } },
        update: { boolValue: pe.bool ?? null, numberValue: pe.number ?? null, unlimited: pe.unlimited ?? false },
        create: { planId: plan.id, entitlementId: def.id, boolValue: pe.bool ?? null, numberValue: pe.number ?? null, unlimited: pe.unlimited ?? false },
      });
    }
  }

  // 3. A default subscription for every organization that has none.
  const defaultPlan = await client.subscriptionPlan.findUnique({ where: { code: DEFAULT_PLAN_CODE } });
  if (!defaultPlan) throw new Error("Bootstrap default plan missing.");
  const orgs = await client.organization.findMany({ where: { subscription: { is: null } }, select: { id: true } });
  for (const org of orgs) {
    const sub = await client.organizationSubscription.create({
      data: {
        organizationId: org.id, planId: defaultPlan.id, status: "ACTIVE",
        billingInterval: "NONE", isDefault: true, currentPeriodStart: new Date(),
      },
    });
    await syncSubscriptionEntitlements(client, sub.id, defaultPlan.id);
  }

  if (orgs.length > 0) {
    await recordAuditEvent("commercial.bootstrap.applied", null, { orgsBootstrapped: orgs.length, defaultPlan: DEFAULT_PLAN_CODE });
  }
  return { orgsBootstrapped: orgs.length };
}
