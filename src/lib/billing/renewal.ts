import { Prisma, type BillingInterval, type BillingProviderKind } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { type ActorMemberships } from "@/lib/auth/tenantContext";
import { requirePlatform } from "./authz";
import { resolveCurrentPrice } from "./pricing";
import { generateInvoiceForPeriod, finalizeInvoiceTx } from "./invoices";
import { createPaymentAttempt, markAttempt, recordPayment } from "./payments";
import { getProvider } from "./provider";
import { applyPaidRenewal, transitionSubscription } from "@/lib/commercial/subscriptions";

/**
 * Phase D3 — subscription renewal, integrating the D2 lifecycle.
 *
 * Idempotent end-to-end: the billing period is keyed on (subscriptionId,
 * periodStart) and the invoice on that period, so repeated or concurrent renewals
 * converge to ONE period, ONE invoice, and ONE payment — no duplicate charges or
 * overlapping periods. D2 remains authoritative for commercial state: a paid
 * renewal advances the period (and cures dunning) via the D2 service boundary; a
 * failed payment moves the subscription along D2's declared transitions
 * (ACTIVE -> PAST_DUE -> GRACE) and NEVER instantly destroys access.
 */

function addInterval(from: Date, interval: BillingInterval): Date {
  const d = new Date(from);
  switch (interval) {
    case "MONTHLY": d.setMonth(d.getMonth() + 1); return d;
    case "QUARTERLY": d.setMonth(d.getMonth() + 3); return d;
    case "YEARLY": d.setFullYear(d.getFullYear() + 1); return d;
    case "NONE": return d;
  }
}

function rawInterval(v: BillingInterval): Prisma.Sql {
  if (!["MONTHLY", "QUARTERLY", "YEARLY", "NONE"].includes(v)) throw new BadRequestError("Invalid billing interval.");
  return Prisma.raw(`'${v}'`);
}

export interface RenewResult {
  billable: boolean;
  reason?: string;
  periodId?: string;
  invoiceId?: string;
  invoiceStatus?: string;
  charged?: boolean;
  paymentSucceeded?: boolean;
}

/**
 * Run one renewal cycle for an organization. `providerKind` selects how payment is
 * executed: NONE leaves the invoice OPEN for out-of-band/manual payment; FAKE
 * drives the deterministic test provider. Platform-only.
 */
export async function renewSubscription(
  m: ActorMemberships,
  input: { organizationId: string; providerKind?: BillingProviderKind; now?: Date; dueInDays?: number }
): Promise<RenewResult> {
  requirePlatform(m);
  const now = input.now ?? new Date();
  const providerKind = input.providerKind ?? "NONE";

  const sub = await prisma.organizationSubscription.findUnique({
    where: { organizationId: input.organizationId },
    include: { plan: true },
  });
  if (!sub) throw new BadRequestError("Organization has no subscription.");
  if (sub.status === "CANCELLED" || sub.status === "EXPIRED") {
    return { billable: false, reason: `Subscription is ${sub.status}.` };
  }

  const price = await resolveCurrentPrice(prisma, sub.planId, sub.billingInterval, now);
  if (!price || sub.billingInterval === "NONE") {
    return { billable: false, reason: "Plan is not billable (no price / NONE interval)." };
  }

  const org = await prisma.organization.findUniqueOrThrow({ where: { id: input.organizationId }, select: { name: true, legalName: true } });
  const account = await prisma.organizationBillingAccount.findUnique({ where: { organizationId: input.organizationId } });

  const periodStart = sub.currentPeriodEnd && sub.currentPeriodEnd > now ? sub.currentPeriodEnd : now;
  const periodEnd = addInterval(periodStart, sub.billingInterval);

  // 1. Idempotent period + DRAFT invoice + finalize, in one transaction.
  const { periodId, invoiceId, totalMinor, invoiceStatus } = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO "BillingPeriod" (id, "subscriptionId", "organizationId", "billingInterval", "periodStart", "periodEnd")
      VALUES (${randomUUID()}, ${sub.id}, ${input.organizationId}, ${rawInterval(sub.billingInterval)}, ${periodStart}, ${periodEnd})
      ON CONFLICT ("subscriptionId", "periodStart") DO NOTHING
    `;
    const period = await tx.billingPeriod.findUniqueOrThrow({ where: { subscriptionId_periodStart: { subscriptionId: sub.id, periodStart } } });

    const invoice = await generateInvoiceForPeriod(tx, {
      organizationId: input.organizationId, subscriptionId: sub.id, planId: sub.planId, billingInterval: sub.billingInterval,
      billingPeriodId: period.id, billingName: account?.billingName ?? org.legalName ?? org.name, billingEmail: account?.billingEmail ?? "",
      idempotencyKey: `renew:${period.id}`, generatedByUserId: m.userId, now,
    });
    if (!invoice) return { periodId: period.id, invoiceId: null as string | null, totalMinor: 0, invoiceStatus: "NONE" };
    const finalized = await finalizeInvoiceTx(tx, invoice.id, m.userId, input.dueInDays ?? 14, now);
    return { periodId: period.id, invoiceId: finalized.id, totalMinor: finalized.totalMinor, invoiceStatus: finalized.status };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20000, maxWait: 10000 });

  if (!invoiceId) return { billable: false, reason: "No invoice generated.", periodId };

  // A zero-total invoice is already PAID at finalize; treat renewal as paid.
  if (invoiceStatus === "PAID") {
    await prisma.$transaction((tx) => applyPaidRenewal(tx, input.organizationId, { periodStart, periodEnd }));
    await recordAuditEvent("commercial.billing.subscriptionRenewed", m.userId, { periodId, invoiceId, charged: false }, { organizationId: input.organizationId });
    return { billable: true, periodId, invoiceId, invoiceStatus, charged: false, paymentSucceeded: true };
  }

  // 2. Payment. NONE = leave OPEN for manual/out-of-band recording.
  if (providerKind === "NONE") {
    return { billable: true, periodId, invoiceId, invoiceStatus, charged: false };
  }

  // 3. Execute payment through the provider (deterministic FAKE in tests).
  const provider = getProvider(providerKind);
  const idem = `renew:${periodId}`;
  const attempt = await prisma.$transaction((tx) => createPaymentAttempt(tx, {
    invoiceId, amountMinor: totalMinor, idempotencyKey: `att:${idem}`, providerKind, createdByUserId: m.userId,
  }));

  // Already succeeded on a previous run? (idempotent re-entry)
  if (attempt.status === "SUCCEEDED") {
    return { billable: true, periodId, invoiceId, invoiceStatus: "PAID", charged: true, paymentSucceeded: true };
  }
  if (attempt.status !== "INITIATED" && attempt.status !== "PENDING") {
    return { billable: true, periodId, invoiceId, invoiceStatus, charged: true, paymentSucceeded: false };
  }

  const result = await provider.createPayment({ amountMinor: totalMinor, currency: price.currency, idempotencyKey: idem, providerCustomerRef: account?.providerCustomerRef });

  if (result.status === "succeeded") {
    await prisma.$transaction(async (tx) => {
      await markAttempt(tx, attempt.id, "SUCCEEDED", { providerPaymentRef: result.providerPaymentRef });
      await recordPayment(tx, {
        invoiceId, attemptId: attempt.id, amountMinor: totalMinor, idempotencyKey: `pay:${idem}`,
        providerKind, providerPaymentRef: result.providerPaymentRef, method: "provider", createdByUserId: m.userId,
      });
      await applyPaidRenewal(tx, input.organizationId, { periodStart, periodEnd });
      await tx.billingPeriod.update({ where: { id: periodId }, data: { status: "INVOICED" } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20000, maxWait: 10000 });
    await recordAuditEvent("commercial.billing.subscriptionRenewed", m.userId, { periodId, invoiceId, charged: true }, { organizationId: input.organizationId });
    return { billable: true, periodId, invoiceId, invoiceStatus: "PAID", charged: true, paymentSucceeded: true };
  }

  // Failure: record on the attempt and advance D2 dunning (never instant suspend).
  await prisma.$transaction((tx) => markAttempt(tx, attempt.id, "FAILED", { providerPaymentRef: result.providerPaymentRef, failureReason: result.failureReason ?? "failed" }));
  await recordAuditEvent("commercial.billing.paymentFailed", m.userId, { invoiceId, reason: result.failureReason ?? "failed" }, { organizationId: input.organizationId });
  await handleFailedPayment(m, input.organizationId);
  return { billable: true, periodId, invoiceId, invoiceStatus, charged: true, paymentSucceeded: false };
}

/**
 * Advance the subscription along D2's dunning transitions after a failed payment.
 * ACTIVE -> PAST_DUE, then PAST_DUE -> GRACE. Never suspends immediately, and
 * never touches safety-critical clinical access (that is C4's concern). Uses the
 * D2 lifecycle service so commercial state stays centralized and audited.
 */
export async function handleFailedPayment(m: ActorMemberships, organizationId: string): Promise<{ from: string; to: string } | null> {
  const sub = await prisma.organizationSubscription.findUnique({ where: { organizationId }, select: { status: true } });
  if (!sub) return null;
  const next = sub.status === "ACTIVE" ? "PAST_DUE" : sub.status === "PAST_DUE" ? "GRACE" : null;
  if (!next) return null;
  await transitionSubscription(m, organizationId, next, "payment_failed");
  return { from: sub.status, to: next };
}
