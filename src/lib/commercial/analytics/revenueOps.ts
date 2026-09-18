import { prisma } from "@/lib/db";
import { assertOrganizationAccess, type ActorMemberships } from "@/lib/auth/tenantContext";
import { requirePlatform } from "@/lib/billing/authz";
import { CurrencyBuckets, invoiceOutstandingMinor, OPEN_INVOICE_STATES, resolvePeriod, type ResolvedPeriod } from "./shared";

/**
 * Phase D5 — revenue operations read model.
 *
 * All figures are server-derived from canonical D3 invoices/payments/refunds/
 * credits and D2 subscriptions, grouped by currency (never summed across
 * currencies). "invoiced"/"collected"/"outstanding" are used deliberately —
 * never "revenue" in the accounting-recognition sense (see d5-revenue-operations).
 */

const COLLECTED_STATES = ["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"] as const;

/** Platform-wide commercial overview for a bounded period + current balances. */
export async function getRevenueOverview(m: ActorMemberships, opts?: { fromISO?: string; toISO?: string }) {
  requirePlatform(m);
  const period = resolvePeriod(opts?.fromISO, opts?.toISO);

  const [invoicedRows, collectedRows, creditRows, refundRows, openInvoices, subCounts, activeOrgs, openExceptions, failedAttempts] = await Promise.all([
    prisma.billingInvoice.groupBy({ by: ["currency"], where: { finalizedAt: { gte: period.from, lt: period.to }, status: { not: "VOID" } }, _sum: { totalMinor: true }, _count: true }),
    prisma.billingPayment.groupBy({ by: ["currency"], where: { succeededAt: { gte: period.from, lt: period.to }, status: { in: [...COLLECTED_STATES] } }, _sum: { amountMinor: true }, _count: true }),
    prisma.billingCredit.groupBy({ by: ["currency"], where: { createdAt: { gte: period.from, lt: period.to } }, _sum: { amountMinor: true } }),
    prisma.billingRefund.findMany({ where: { createdAt: { gte: period.from, lt: period.to }, status: "SUCCEEDED" }, select: { amountMinor: true, payment: { select: { currency: true } } } }),
    prisma.billingInvoice.findMany({ where: { status: { in: OPEN_INVOICE_STATES } }, select: { currency: true, status: true, totalMinor: true, amountPaidMinor: true, dueAt: true } }),
    prisma.organizationSubscription.groupBy({ by: ["status"], _count: true }),
    prisma.organization.count({ where: { status: "ACTIVE" } }),
    prisma.billingReconciliationException.count({ where: { resolved: false } }),
    prisma.billingPaymentAttempt.count({ where: { status: "FAILED", createdAt: { gte: period.from, lt: period.to } } }),
  ]);

  const invoiced = new CurrencyBuckets(); for (const r of invoicedRows) invoiced.add(r.currency, r._sum.totalMinor ?? 0);
  const collected = new CurrencyBuckets(); for (const r of collectedRows) collected.add(r.currency, r._sum.amountMinor ?? 0);
  const credited = new CurrencyBuckets(); for (const r of creditRows) credited.add(r.currency, r._sum.amountMinor ?? 0);
  const refunded = new CurrencyBuckets(); for (const r of refundRows) refunded.add(r.payment.currency, r.amountMinor);
  const outstanding = new CurrencyBuckets(); const overdue = new CurrencyBuckets();
  const now = new Date();
  for (const inv of openInvoices) {
    const out = invoiceOutstandingMinor(inv);
    outstanding.add(inv.currency, out);
    if (inv.dueAt && inv.dueAt < now) overdue.add(inv.currency, out);
  }

  const subscriptionStates: Record<string, number> = {};
  let activeSubscriptions = 0;
  for (const s of subCounts) { subscriptionStates[s.status] = s._count; if (s.status === "ACTIVE" || s.status === "TRIAL") activeSubscriptions += s._count; }

  return {
    period: { from: period.from, to: period.to, days: period.days, timezone: "UTC" },
    kpis: {
      activeOrganizations: activeOrgs,
      activeSubscriptions,
      openReconciliationExceptions: openExceptions,
      failedPaymentsInPeriod: failedAttempts,
    },
    invoiced: invoiced.toArray(),
    collected: collected.toArray(),
    refunded: refunded.toArray(),
    credited: credited.toArray(),
    outstanding: outstanding.toArray(),
    overdue: overdue.toArray(),
    subscriptionStates,
  };
}

/** Tenant-scoped accounts-receivable view for one organization. */
export async function getOrganizationAR(m: ActorMemberships, organizationId: string) {
  assertOrganizationAccess(m, organizationId);
  const now = new Date();

  const [openInvoices, sub, lastSuccess, lastFailure] = await Promise.all([
    prisma.billingInvoice.findMany({ where: { organizationId, status: { in: OPEN_INVOICE_STATES } }, select: { id: true, invoiceNumber: true, currency: true, status: true, totalMinor: true, amountPaidMinor: true, dueAt: true, finalizedAt: true }, orderBy: [{ finalizedAt: "asc" }, { createdAt: "asc" }] }),
    prisma.organizationSubscription.findUnique({ where: { organizationId }, select: { status: true, currentPeriodEnd: true, trialEndsAt: true } }),
    prisma.billingPayment.findFirst({ where: { organizationId, status: { in: [...COLLECTED_STATES] } }, orderBy: { succeededAt: "desc" }, select: { amountMinor: true, currency: true, succeededAt: true } }),
    prisma.billingPaymentAttempt.findFirst({ where: { organizationId, status: "FAILED" }, orderBy: { createdAt: "desc" }, select: { amountMinor: true, failureCode: true, createdAt: true } }),
  ]);

  const outstanding = new CurrencyBuckets(); const overdue = new CurrencyBuckets();
  let oldest: { id: string; invoiceNumber: string | null; outstandingMinor: number; dueAt: Date | null } | null = null;
  let overdueCount = 0;
  for (const inv of openInvoices) {
    const out = invoiceOutstandingMinor(inv);
    outstanding.add(inv.currency, out);
    if (inv.dueAt && inv.dueAt < now) { overdue.add(inv.currency, out); overdueCount++; }
    if (out > 0 && !oldest) oldest = { id: inv.id, invoiceNumber: inv.invoiceNumber, outstandingMinor: out, dueAt: inv.dueAt };
  }

  return {
    organizationId,
    commercialState: sub?.status ?? "NONE",
    nextBillingAt: sub?.currentPeriodEnd ?? sub?.trialEndsAt ?? null,
    openInvoiceCount: openInvoices.length,
    overdueInvoiceCount: overdueCount,
    outstanding: outstanding.toArray(),
    overdue: overdue.toArray(),
    oldestOutstandingInvoice: oldest,
    lastSuccessfulPayment: lastSuccess,
    lastFailedPayment: lastFailure,
  };
}

const AGING_BUCKETS = [
  { key: "current", min: -Infinity, max: 0 },
  { key: "1-30", min: 0, max: 30 },
  { key: "31-60", min: 30, max: 60 },
  { key: "61-90", min: 60, max: 90 },
  { key: "91-120", min: 90, max: 120 },
  { key: "120+", min: 120, max: Infinity },
] as const;

/**
 * Deterministic invoice aging by DUE DATE (D3's `dueAt`). Age = whole days since
 * dueAt at the reference instant; a not-yet-due open invoice is "current".
 * Buckets are grouped by currency. Platform sees all; an org caller only its own.
 */
export async function getAging(m: ActorMemberships, opts?: { organizationId?: string; now?: Date }) {
  if (opts?.organizationId) assertOrganizationAccess(m, opts.organizationId);
  else requirePlatform(m);
  const now = opts?.now ?? new Date();

  const invoices = await prisma.billingInvoice.findMany({
    where: { status: { in: OPEN_INVOICE_STATES }, ...(opts?.organizationId ? { organizationId: opts.organizationId } : {}) },
    select: { currency: true, status: true, totalMinor: true, amountPaidMinor: true, dueAt: true },
  });

  const buckets = AGING_BUCKETS.map((b) => ({ bucket: b.key, byCurrency: new CurrencyBuckets() }));
  for (const inv of invoices) {
    const out = invoiceOutstandingMinor(inv);
    if (out <= 0) continue;
    const ageDays = inv.dueAt ? Math.floor((now.getTime() - inv.dueAt.getTime()) / 86_400_000) : 0;
    const idx = AGING_BUCKETS.findIndex((b) => ageDays > b.min && ageDays <= b.max);
    buckets[idx === -1 ? 0 : idx].byCurrency.add(inv.currency, out);
  }
  return {
    referenceField: "dueAt",
    referenceInstant: now,
    buckets: buckets.map((b) => ({ bucket: b.bucket, amounts: b.byCurrency.toArray() })),
  };
}

export type { ResolvedPeriod };
