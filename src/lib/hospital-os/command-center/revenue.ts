import { prisma } from "@/lib/db";
import type { CommandContext } from "./authz";
import { metric, driver, section } from "./_build";
import { startOfToday } from "./filters";
import type { CommandSection } from "./types";

/**
 * REVENUE — the hospital PATIENT revenue cycle (Invoice/Payment), distinct from the
 * D3/D5 SaaS commercial layer. Amounts are integer minor units summed only within a
 * single currency (INR), presented in whole INR. Financial section — requires
 * `billing:view`. "Outstanding" is issued-minus-allocated; run-rate is never called
 * "revenue".
 */
export async function getRevenue(ctx: CommandContext): Promise<CommandSection> {
  const f = ctx.facilityId;
  const today = startOfToday(ctx.now);
  const [billedToday, collectedToday, outstanding, openInvoices, unallocatedPayments] = await Promise.all([
    prisma.invoice.aggregate({ _sum: { totalMinor: true }, where: { facilityId: f, issuedAt: { gte: today }, status: { not: "VOID" } } }),
    prisma.payment.aggregate({ _sum: { amountMinor: true }, where: { facilityId: f, receivedAt: { gte: today }, status: "RECEIVED" } }),
    prisma.invoice.findMany({ where: { facilityId: f, status: { in: ["ISSUED", "PARTIALLY_PAID"] } }, select: { totalMinor: true, allocatedMinor: true } }),
    prisma.invoice.count({ where: { facilityId: f, status: { in: ["ISSUED", "PARTIALLY_PAID"] } } }),
    prisma.payment.count({ where: { facilityId: f, status: "RECEIVED", allocatedMinor: 0 } }),
  ]);
  const inr = (minor: number) => Math.round(minor / 100);
  const billed = inr(billedToday._sum.totalMinor ?? 0);
  const collected = inr(collectedToday._sum.amountMinor ?? 0);
  const outstandingMinor = outstanding.reduce((a, i) => a + Math.max(0, i.totalMinor - i.allocatedMinor), 0);

  const metrics = [
    metric({ key: "billedToday", label: "Billed today", value: billed, unit: "INR", timeSemantics: "PERIOD_AGGREGATE", source: "Invoice", explanation: "Sum of non-void invoice totals issued today." }),
    metric({ key: "collectedToday", label: "Collected today", value: collected, unit: "INR", timeSemantics: "PERIOD_AGGREGATE", source: "Payment", explanation: "Sum of payments received today." }),
    metric({ key: "outstanding", label: "Outstanding (AR)", value: inr(outstandingMinor), unit: "INR", timeSemantics: "CURRENT_STATE", source: "Invoice", explanation: `Issued minus allocated across ${openInvoices} open invoice(s).` }),
  ];
  const drivers = [
    driver("Open invoices", openInvoices, "DIRECT", "/api/hospital/command-center/drilldown?kind=open-invoices"),
    driver("Unallocated payments", unallocatedPayments, "CONTRIBUTING"),
    driver("Collected today (INR)", collected, "CONTRIBUTING"),
  ];
  return section(ctx, { key: "revenue", label: "Revenue", metrics, drivers, drillDown: "/api/hospital/command-center/drilldown?kind=open-invoices" });
}
