import { Prisma, type BillingCreditType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { assertOrganizationAccess, type ActorMemberships } from "@/lib/auth/tenantContext";
import { requirePlatform } from "./authz";
import { computeTotals } from "./invoices";
import { isInvoiceMutable } from "./constants";

/**
 * Phase D3 — commercial credits & adjustments.
 *
 * Platform-only: an organization administrator can NEVER credit their own account
 * (no self-credit / self-discount). A credit is granted to an organization and
 * carries a running remainingMinor; applying it to a DRAFT invoice adds a CREDIT
 * line and decrements the balance (guarded) — a finalized invoice is never
 * rewritten. Every action is audited with actor, org, amount and reason.
 */

export interface IssueCreditInput {
  organizationId: string;
  amountMinor: number;
  type: BillingCreditType;
  reason: string;
}

export async function issueCredit(m: ActorMemberships, input: IssueCreditInput) {
  requirePlatform(m);
  if (input.amountMinor <= 0) throw new BadRequestError("Credit amount must be positive.");
  const org = await prisma.organization.findUnique({ where: { id: input.organizationId }, select: { id: true } });
  if (!org) throw new NotFoundError();
  const credit = await prisma.billingCredit.create({
    data: {
      organizationId: input.organizationId, amountMinor: input.amountMinor, remainingMinor: input.amountMinor,
      type: input.type, reason: input.reason, createdByUserId: m.userId,
    },
  });
  await recordAuditEvent("commercial.billing.creditIssued", m.userId, { creditId: credit.id, amountMinor: input.amountMinor, type: input.type }, { organizationId: input.organizationId });
  return credit;
}

/**
 * Apply (part of) a credit to a DRAFT invoice of the SAME organization. Guarded
 * decrement of the credit balance + a CREDIT line + totals recompute, atomically.
 * Refuses cross-organization application and refuses finalized invoices.
 */
export async function applyCreditToInvoice(m: ActorMemberships, input: { creditId: string; invoiceId: string; amountMinor: number }) {
  requirePlatform(m);
  if (input.amountMinor <= 0) throw new BadRequestError("Applied amount must be positive.");
  return prisma.$transaction(async (tx) => {
    const credit = await tx.billingCredit.findUnique({ where: { id: input.creditId } });
    if (!credit) throw new NotFoundError();
    const invoice = await tx.billingInvoice.findUnique({ where: { id: input.invoiceId } });
    if (!invoice) throw new NotFoundError();
    if (invoice.organizationId !== credit.organizationId) throw new BadRequestError("Credit and invoice belong to different organizations.");
    if (!isInvoiceMutable(invoice.status)) throw new BadRequestError("Credits apply to DRAFT invoices only; a finalized invoice is corrected by a new credit note, never edited.");

    // Guarded balance decrement — cannot over-apply even under concurrency.
    const applied = await tx.$executeRaw`
      UPDATE "BillingCredit" SET "remainingMinor" = "remainingMinor" - ${input.amountMinor}
      WHERE id = ${input.creditId} AND "remainingMinor" >= ${input.amountMinor} AND status = 'ACTIVE'
    `;
    if (Number(applied) !== 1) throw new BadRequestError("Insufficient credit balance.");

    await tx.billingInvoiceLine.create({
      data: {
        invoiceId: input.invoiceId, type: "CREDIT", description: `Credit applied (${credit.type.toLowerCase()})`,
        quantity: 1, unitAmountMinor: -input.amountMinor, amountMinor: -input.amountMinor, taxAmountMinor: 0, taxRateBps: 0,
      },
    });
    const lines = await tx.billingInvoiceLine.findMany({ where: { invoiceId: input.invoiceId } });
    await tx.billingInvoice.update({ where: { id: input.invoiceId }, data: computeTotals(lines) });

    const after = await tx.billingCredit.findUniqueOrThrow({ where: { id: input.creditId } });
    if (after.remainingMinor === 0) await tx.billingCredit.update({ where: { id: input.creditId }, data: { status: "APPLIED", invoiceId: input.invoiceId } });

    await recordAuditEvent("commercial.billing.creditApplied", m.userId, { creditId: input.creditId, invoiceId: input.invoiceId, amountMinor: input.amountMinor }, { organizationId: invoice.organizationId }, tx);
    return tx.billingInvoice.findUniqueOrThrow({ where: { id: input.invoiceId }, include: { lines: true } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20000, maxWait: 10000 });
}

/** Tenant-scoped list of an organization's credits. */
export async function listCredits(m: ActorMemberships, organizationId: string) {
  assertOrganizationAccess(m, organizationId);
  return prisma.billingCredit.findMany({ where: { organizationId }, orderBy: { createdAt: "desc" } });
}
