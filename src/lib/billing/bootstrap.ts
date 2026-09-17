import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auth/audit";
import { PLAN_PRICES } from "./pricing";
import { getOrCreateBillingAccount } from "./billingAccount";

/**
 * Phase D3 — billing bootstrap.
 *
 * Idempotently materialises CODE-defined pricing (PLAN_PRICES) into PlanPrice and
 * gives every organization a billing account. It NEVER fabricates invoices or
 * payment history — a bootstrapped organization simply has an account and its
 * plans have prices; its billing history is honestly empty until real activity
 * occurs. A price change (amount differs from the current active row) is applied
 * as a NEW effective-dated version, retiring the old row rather than editing it,
 * so historical invoices stay understandable. Safe to run repeatedly (seed).
 */
export async function ensureBillingBootstrap(client = prisma): Promise<{ pricesCreated: number; accountsCreated: number }> {
  let pricesCreated = 0;
  const now = new Date();

  for (const spec of PLAN_PRICES) {
    const plan = await client.subscriptionPlan.findUnique({ where: { code: spec.planCode }, select: { id: true } });
    if (!plan) continue; // plan catalogue not bootstrapped yet (D2) — next run will pick it up

    const current = await client.planPrice.findFirst({
      where: { planId: plan.id, billingInterval: spec.billingInterval, active: true },
      orderBy: [{ version: "desc" }],
    });
    if (current && current.amountMinor === spec.amountMinor && current.taxCode === spec.taxCode) continue; // unchanged

    if (current) {
      // Retire the old price (never edit it) and add the next version.
      await client.planPrice.update({ where: { id: current.id }, data: { active: false, effectiveTo: now } });
    }
    await client.planPrice.create({
      data: {
        planId: plan.id, billingInterval: spec.billingInterval, amountMinor: spec.amountMinor,
        taxCode: spec.taxCode, currency: "INR", version: (current?.version ?? 0) + 1, effectiveFrom: now, active: true,
      },
    });
    pricesCreated++;
  }

  // A billing account for every organization that lacks one. billingEmail is left
  // blank (honestly "not set") until an administrator provides one — never invented.
  const orgs = await client.organization.findMany({
    where: { billingAccount: { is: null } },
    select: { id: true, name: true, legalName: true },
  });
  for (const org of orgs) {
    await getOrCreateBillingAccount(client, org.id, { billingName: org.legalName ?? org.name, billingEmail: "" });
  }

  if (pricesCreated > 0 || orgs.length > 0) {
    await recordAuditEvent("commercial.billing.bootstrapApplied", null, { pricesCreated, accountsCreated: orgs.length });
  }
  return { pricesCreated, accountsCreated: orgs.length };
}
