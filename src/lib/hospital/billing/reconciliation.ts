import { prisma } from "@/lib/db";
import { sumMinor } from "./money";

interface DateRange {
  from: Date;
  to: Date;
}

/**
 * 4 on-demand aggregate reads, nothing persisted or scheduled — this phase
 * deliberately does not build a BI warehouse (see
 * docs/PHASE_5_SCOPE_AND_DEFERRALS.md). Every number is derived live from
 * immutable/append-only rows, same philosophy as billingAccount.ts.
 */

export async function dailyCollectionByMethod(facilityId: string, range: DateRange) {
  const [payments, refunds] = await Promise.all([
    prisma.payment.groupBy({
      by: ["method"],
      where: { facilityId, status: "RECEIVED", receivedAt: { gte: range.from, lt: range.to } },
      _sum: { amountMinor: true },
    }),
    prisma.refund.findMany({
      where: { status: "COMPLETED", completedAt: { gte: range.from, lt: range.to }, payment: { facilityId } },
      select: { amountMinor: true, payment: { select: { method: true } } },
    }),
  ]);

  const refundedByMethod = new Map<string, number>();
  for (const r of refunds) {
    refundedByMethod.set(r.payment.method, (refundedByMethod.get(r.payment.method) ?? 0) + r.amountMinor);
  }

  return payments.map((p) => ({
    method: p.method,
    grossMinor: p._sum.amountMinor ?? 0,
    refundedMinor: refundedByMethod.get(p.method) ?? 0,
    netMinor: (p._sum.amountMinor ?? 0) - (refundedByMethod.get(p.method) ?? 0),
  }));
}

export async function outstandingByPayer(facilityId: string) {
  const invoices = await prisma.invoice.findMany({
    where: { facilityId, status: { in: ["ISSUED", "PARTIALLY_PAID"] } },
    select: { payerId: true, payer: { select: { name: true } }, totalMinor: true, allocations: { select: { amountMinor: true } } },
  });

  const byPayer = new Map<string, { payerName: string; outstandingMinor: number }>();
  for (const inv of invoices) {
    const key = inv.payerId ?? "SELF_PAY";
    const name = inv.payer?.name ?? "Self-Pay";
    const allocated = sumMinor(inv.allocations.map((a) => a.amountMinor));
    const outstanding = inv.totalMinor - allocated;
    const existing = byPayer.get(key) ?? { payerName: name, outstandingMinor: 0 };
    existing.outstandingMinor += outstanding;
    byPayer.set(key, existing);
  }

  return Array.from(byPayer.entries()).map(([payerId, v]) => ({ payerId, ...v }));
}

/**
 * Directly guards against the exact failure mode the old Bill mutable
 * counter could silently hide: a charge that was posted but never made it
 * onto any invoice, or an invoice total that doesn't match what was
 * actually collected.
 */
export async function chargeInvoiceCollectionLeakage(facilityId: string, range: DateRange) {
  const [charges, invoices, allocations] = await Promise.all([
    prisma.charge.findMany({ where: { facilityId, status: "POSTED", createdAt: { gte: range.from, lt: range.to } }, select: { netAmountMinor: true } }),
    prisma.invoice.findMany({ where: { facilityId, status: { not: "VOID" }, createdAt: { gte: range.from, lt: range.to } }, select: { totalMinor: true } }),
    prisma.paymentAllocation.findMany({
      where: { allocatedAt: { gte: range.from, lt: range.to }, invoice: { facilityId } },
      select: { amountMinor: true },
    }),
  ]);

  return {
    grossChargesMinor: sumMinor(charges.map((c) => c.netAmountMinor)),
    invoicedMinor: sumMinor(invoices.map((i) => i.totalMinor)),
    collectedMinor: sumMinor(allocations.map((a) => a.amountMinor)),
  };
}

export async function claimAging(facilityId: string, atDate: Date = new Date()) {
  const claims = await prisma.claim.findMany({
    where: { facilityId, status: { notIn: ["CLOSED"] } },
    select: { status: true, submittedAt: true, submittedAmountMinor: true },
  });

  const buckets = { "0-7": 0, "8-30": 0, "31+": 0, unsubmitted: 0 } as Record<string, number>;
  const amountsByBucket = { "0-7": 0, "8-30": 0, "31+": 0, unsubmitted: 0 } as Record<string, number>;
  for (const claim of claims) {
    if (!claim.submittedAt) {
      buckets.unsubmitted += 1;
      amountsByBucket.unsubmitted += claim.submittedAmountMinor;
      continue;
    }
    const daysSince = Math.floor((atDate.getTime() - claim.submittedAt.getTime()) / (24 * 60 * 60 * 1000));
    const bucket = daysSince <= 7 ? "0-7" : daysSince <= 30 ? "8-30" : "31+";
    buckets[bucket] += 1;
    amountsByBucket[bucket] += claim.submittedAmountMinor;
  }

  const byStatus = new Map<string, number>();
  for (const claim of claims) byStatus.set(claim.status, (byStatus.get(claim.status) ?? 0) + 1);

  return { countByAgeBucket: buckets, amountMinorByAgeBucket: amountsByBucket, countByStatus: Object.fromEntries(byStatus) };
}
