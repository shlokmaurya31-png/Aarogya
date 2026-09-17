import { prisma } from "@/lib/db";
import { assertOrganizationAccess, type ActorMemberships } from "@/lib/auth/tenantContext";
import { resolveCurrentPrice } from "./pricing";

/**
 * Phase D3 — the billing read model for the enterprise workspace.
 *
 * Tenant-scoped: assertOrganizationAccess re-checks the caller has standing, so an
 * org/facility admin only ever sees THEIR OWN billing state. Returns honest empty
 * states (no account, no invoices) rather than fabricated data, and never exposes
 * provider secrets. Outstanding balance is derived live from invoice totals.
 */
export async function getBillingSummary(m: ActorMemberships, organizationId: string) {
  assertOrganizationAccess(m, organizationId);
  const now = new Date();

  const [account, sub, invoices, credits] = await Promise.all([
    prisma.organizationBillingAccount.findUnique({ where: { organizationId } }),
    prisma.organizationSubscription.findUnique({ where: { organizationId }, include: { plan: true } }),
    prisma.billingInvoice.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
      include: { payments: true },
      take: 50,
    }),
    prisma.billingCredit.findMany({ where: { organizationId, status: "ACTIVE" }, orderBy: { createdAt: "desc" } }),
  ]);

  const currentPrice = sub ? await resolveCurrentPrice(prisma, sub.planId, sub.billingInterval, now) : null;

  const outstandingMinor = invoices
    .filter((i) => i.status === "OPEN" || i.status === "PARTIALLY_PAID" || i.status === "PAST_DUE")
    .reduce((sum, i) => sum + (i.totalMinor - i.amountPaidMinor), 0);

  return {
    canManage: m.isPlatformAdmin,
    account: account && {
      billingName: account.billingName,
      billingEmail: account.billingEmail || null,
      billingAddress: account.billingAddress,
      taxId: account.taxId,
      currency: account.currency,
      status: account.status,
      providerKind: account.providerKind,
      // Deliberately NOT exposing providerCustomerRef beyond its presence.
      providerLinked: !!account.providerCustomerRef,
    },
    pricing: currentPrice && {
      amountMinor: currentPrice.amountMinor,
      currency: currentPrice.currency,
      billingInterval: sub?.billingInterval,
      version: currentPrice.version,
    },
    nextBillingAt: sub?.currentPeriodEnd ?? sub?.trialEndsAt ?? null,
    outstandingMinor,
    invoices: invoices.map((i) => ({
      id: i.id,
      invoiceNumber: i.invoiceNumber,
      status: i.status,
      currency: i.currency,
      totalMinor: i.totalMinor,
      amountPaidMinor: i.amountPaidMinor,
      issuedAt: i.issuedAt,
      dueAt: i.dueAt,
      paymentCount: i.payments.length,
    })),
    credits: credits.map((c) => ({ id: c.id, amountMinor: c.amountMinor, remainingMinor: c.remainingMinor, type: c.type, reason: c.reason })),
  };
}
