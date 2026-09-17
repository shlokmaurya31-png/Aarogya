import { prisma } from "@/lib/db";
import type { Prisma, BillingInterval } from "@prisma/client";

/**
 * Phase D3 — authoritative SaaS pricing.
 *
 * Price is CODE-defined here and materialised into the PlanPrice table by the
 * billing bootstrap, exactly as D2's entitlement registry is materialised. Price
 * is NEVER a random conditional in a route, and NEVER supplied by a client — the
 * server resolves the current PlanPrice row for a plan + interval. A price change
 * is a NEW effective-dated row (see bootstrap.ts), so an invoice raised under an
 * old price stays understandable and historical invoices never move.
 *
 * Amounts are integer minor units (paise). taxCode is a label for the tax
 * boundary (see tax.ts) — no tax engine ships in D3.
 */

export interface PlanPriceSpec {
  planCode: string;
  billingInterval: BillingInterval;
  amountMinor: number;
  taxCode: string | null;
}

/**
 * The sold plans carry a real price. The internal `aarogya-default` grandfather
 * plan (BillingInterval NONE) is deliberately ABSENT — it is not a commercial
 * contract and is never billed. An org on it has no PlanPrice, so renewal treats
 * it as non-billable rather than inventing a charge.
 */
export const PLAN_PRICES: PlanPriceSpec[] = [
  { planCode: "starter", billingInterval: "MONTHLY", amountMinor: 499_900, taxCode: "GST_18" },
  { planCode: "professional", billingInterval: "MONTHLY", amountMinor: 2_499_900, taxCode: "GST_18" },
  { planCode: "enterprise", billingInterval: "YEARLY", amountMinor: 99_900_000, taxCode: "GST_18" },
];

type DbClient = Prisma.TransactionClient | typeof prisma;

/**
 * Resolve the current authoritative price for a plan at an interval. Returns the
 * newest ACTIVE, currently-effective PlanPrice row, or null if the plan is not
 * billable at that interval (e.g. the grandfather plan). Never trusts a caller
 * for the amount.
 */
export async function resolveCurrentPrice(
  client: DbClient,
  planId: string,
  billingInterval: BillingInterval,
  now: Date = new Date()
): Promise<{ amountMinor: number; currency: string; taxCode: string | null; version: number; priceId: string } | null> {
  const rows = await client.planPrice.findMany({
    where: { planId, billingInterval, active: true },
    orderBy: [{ effectiveFrom: "desc" }, { version: "desc" }],
  });
  const effective = rows.find((r) => r.effectiveFrom <= now && (!r.effectiveTo || r.effectiveTo > now));
  if (!effective) return null;
  return {
    amountMinor: effective.amountMinor,
    currency: effective.currency,
    taxCode: effective.taxCode,
    version: effective.version,
    priceId: effective.id,
  };
}
