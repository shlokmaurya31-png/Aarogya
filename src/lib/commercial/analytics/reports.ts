import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auth/audit";
import { type ActorMemberships } from "@/lib/auth/tenantContext";
import { requirePlatform } from "@/lib/billing/authz";
import { invoiceOutstandingMinor, OPEN_INVOICE_STATES, resolvePeriod, toCsv } from "./shared";

/**
 * Phase D5 — server-generated commercial reports.
 *
 * Canonical data only, bounded periods, platform-only. All monetary columns are
 * integer minor units with an explicit currency column (currencies never merged).
 * Date semantics: UTC, half-open window [from, to); invoices included by
 * finalizedAt, payments by succeededAt, refunds/credits by createdAt; outstanding
 * is the current authoritative balance (not period-bounded). No secrets, no raw
 * payloads.
 */

const COLLECTED = ["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"] as const;
const AGING = [
  { key: "current", max: 0 }, { key: "1-30", max: 30 }, { key: "31-60", max: 60 },
  { key: "61-90", max: 90 }, { key: "91-120", max: 120 }, { key: "120+", max: Infinity },
];

async function orgNames(ids: string[]): Promise<Map<string, string>> {
  const rows = await prisma.organization.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true } });
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function revenueReport(m: ActorMemberships, opts?: { fromISO?: string; toISO?: string }) {
  requirePlatform(m);
  const period = resolvePeriod(opts?.fromISO, opts?.toISO);
  const key = (org: string, cur: string) => `${org}|${cur}`;
  const acc = new Map<string, { organizationId: string; currency: string; invoicedMinor: number; collectedMinor: number; refundedMinor: number; creditedMinor: number; outstandingMinor: number }>();
  const bump = (org: string, cur: string, field: "invoicedMinor" | "collectedMinor" | "refundedMinor" | "creditedMinor" | "outstandingMinor", v: number) => {
    const k = key(org, cur);
    const row = acc.get(k) ?? { organizationId: org, currency: cur, invoicedMinor: 0, collectedMinor: 0, refundedMinor: 0, creditedMinor: 0, outstandingMinor: 0 };
    row[field] += v; acc.set(k, row);
  };

  const [inv, pay, cred, refunds, open] = await Promise.all([
    prisma.billingInvoice.groupBy({ by: ["organizationId", "currency"], where: { finalizedAt: { gte: period.from, lt: period.to }, status: { not: "VOID" } }, _sum: { totalMinor: true } }),
    prisma.billingPayment.groupBy({ by: ["organizationId", "currency"], where: { succeededAt: { gte: period.from, lt: period.to }, status: { in: [...COLLECTED] } }, _sum: { amountMinor: true } }),
    prisma.billingCredit.groupBy({ by: ["organizationId", "currency"], where: { createdAt: { gte: period.from, lt: period.to } }, _sum: { amountMinor: true } }),
    prisma.billingRefund.findMany({ where: { createdAt: { gte: period.from, lt: period.to }, status: "SUCCEEDED" }, select: { amountMinor: true, payment: { select: { organizationId: true, currency: true } } } }),
    prisma.billingInvoice.findMany({ where: { status: { in: OPEN_INVOICE_STATES } }, select: { organizationId: true, currency: true, status: true, totalMinor: true, amountPaidMinor: true } }),
  ]);
  for (const r of inv) bump(r.organizationId, r.currency, "invoicedMinor", r._sum.totalMinor ?? 0);
  for (const r of pay) bump(r.organizationId, r.currency, "collectedMinor", r._sum.amountMinor ?? 0);
  for (const r of cred) bump(r.organizationId, r.currency, "creditedMinor", r._sum.amountMinor ?? 0);
  for (const r of refunds) bump(r.payment.organizationId, r.payment.currency, "refundedMinor", r.amountMinor);
  for (const r of open) bump(r.organizationId, r.currency, "outstandingMinor", invoiceOutstandingMinor(r));

  const names = await orgNames([...acc.values()].map((r) => r.organizationId));
  const rows = [...acc.values()].map((r) => ({ organization: names.get(r.organizationId) ?? r.organizationId, ...r }));
  const columns = ["organization", "organizationId", "currency", "invoicedMinor", "collectedMinor", "refundedMinor", "creditedMinor", "outstandingMinor"];
  await recordAuditEvent("commercial.report.generated", m.userId, { report: "revenue" });
  return { report: "revenue", meta: { timezone: "UTC", from: period.from, to: period.to, unit: "minor", inclusion: { invoices: "finalizedAt", payments: "succeededAt", refundsCredits: "createdAt", outstanding: "current" } }, columns, rows, csv: toCsv(columns, rows) };
}

export async function arAgingReport(m: ActorMemberships, opts?: { now?: Date }) {
  requirePlatform(m);
  const now = opts?.now ?? new Date();
  const invoices = await prisma.billingInvoice.findMany({ where: { status: { in: OPEN_INVOICE_STATES } }, select: { id: true, invoiceNumber: true, organizationId: true, currency: true, status: true, totalMinor: true, amountPaidMinor: true, dueAt: true } });
  const names = await orgNames(invoices.map((i) => i.organizationId));
  const rows = invoices
    .map((i) => ({ i, out: invoiceOutstandingMinor(i) }))
    .filter((x) => x.out > 0)
    .map(({ i, out }) => {
      const age = i.dueAt ? Math.floor((now.getTime() - i.dueAt.getTime()) / 86_400_000) : 0;
      const bucket = AGING.find((b) => age <= b.max)!.key;
      return { organization: names.get(i.organizationId) ?? i.organizationId, organizationId: i.organizationId, invoiceNumber: i.invoiceNumber ?? "", currency: i.currency, outstandingMinor: out, ageDays: age < 0 ? 0 : age, bucket, dueAt: i.dueAt?.toISOString() ?? "" };
    });
  const columns = ["organization", "organizationId", "invoiceNumber", "currency", "outstandingMinor", "ageDays", "bucket", "dueAt"];
  await recordAuditEvent("commercial.report.generated", m.userId, { report: "ar_aging" });
  return { report: "ar_aging", meta: { timezone: "UTC", referenceField: "dueAt", referenceInstant: now, unit: "minor" }, columns, rows, csv: toCsv(columns, rows) };
}

export async function paymentReport(m: ActorMemberships, opts?: { fromISO?: string; toISO?: string }) {
  requirePlatform(m);
  const period = resolvePeriod(opts?.fromISO, opts?.toISO);
  const payments = await prisma.billingPayment.findMany({ where: { succeededAt: { gte: period.from, lt: period.to } }, select: { id: true, organizationId: true, invoiceId: true, amountMinor: true, refundedMinor: true, currency: true, status: true, providerKind: true, succeededAt: true }, orderBy: { succeededAt: "desc" }, take: 5000 });
  const names = await orgNames(payments.map((p) => p.organizationId));
  const rows = payments.map((p) => ({ organization: names.get(p.organizationId) ?? p.organizationId, organizationId: p.organizationId, invoiceId: p.invoiceId, amountMinor: p.amountMinor, refundedMinor: p.refundedMinor, currency: p.currency, status: p.status, provider: p.providerKind, succeededAt: p.succeededAt.toISOString() }));
  const columns = ["organization", "organizationId", "invoiceId", "amountMinor", "refundedMinor", "currency", "status", "provider", "succeededAt"];
  await recordAuditEvent("commercial.report.generated", m.userId, { report: "payments" });
  return { report: "payments", meta: { timezone: "UTC", from: period.from, to: period.to, inclusion: "succeededAt", unit: "minor" }, columns, rows, csv: toCsv(columns, rows) };
}

export async function reconciliationReport(m: ActorMemberships) {
  requirePlatform(m);
  const ex = await prisma.billingReconciliationException.findMany({ orderBy: [{ resolved: "asc" }, { createdAt: "desc" }], take: 5000, select: { id: true, organizationId: true, kind: true, severity: true, status: true, source: true, providerKind: true, createdAt: true, resolvedAt: true } });
  const rows = ex.map((e) => ({ id: e.id, organizationId: e.organizationId ?? "", kind: e.kind, severity: e.severity, status: e.status, source: e.source, provider: e.providerKind, detectedAt: e.createdAt.toISOString(), resolvedAt: e.resolvedAt?.toISOString() ?? "" }));
  const columns = ["id", "organizationId", "kind", "severity", "status", "source", "provider", "detectedAt", "resolvedAt"];
  await recordAuditEvent("commercial.report.generated", m.userId, { report: "reconciliation" });
  return { report: "reconciliation", meta: { timezone: "UTC" }, columns, rows, csv: toCsv(columns, rows) };
}
