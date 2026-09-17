import { Prisma, type BillingInterval, type BillingInvoiceLineType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { assertOrganizationAccess, type ActorMemberships } from "@/lib/auth/tenantContext";
import { requirePlatform } from "./authz";
import { getOrCreateBillingAccount } from "./billingAccount";
import { resolveCurrentPrice } from "./pricing";
import { computeTaxMinor } from "./tax";
import { nextInvoiceSequence, formatInvoiceNumber } from "./sequence";
import { isInvoiceMutable, isInvoicePayable } from "./constants";
import { sumMinor } from "./money";

type Tx = Prisma.TransactionClient;
type DbClient = Tx | typeof prisma;

/**
 * Phase D3 — SaaS invoice service.
 *
 * Amounts are ALWAYS computed here from server-resolved prices and lines; a
 * client never supplies a total, price, tax or discount. A DRAFT invoice is
 * mutable; finalization freezes the invoiceNumber and every amount, after which
 * corrections are a credit/void+replacement, never an in-place edit. Generation
 * is idempotent via the 1:1 billing-period link (and the invoice idempotencyKey).
 */

interface LineDraft {
  type: BillingInvoiceLineType;
  description: string;
  quantity: number;
  unitAmountMinor: number;
  taxCode?: string | null;
}

/** Deterministic totals from lines. discount = sum of CREDIT lines (stored as negative amounts). */
export function computeTotals(lines: { type: BillingInvoiceLineType; amountMinor: number; taxAmountMinor: number }[]) {
  const charges = lines.filter((l) => l.type !== "CREDIT" && l.type !== "TAX");
  const credits = lines.filter((l) => l.type === "CREDIT");
  const subtotalMinor = sumMinor(charges.map((l) => l.amountMinor));
  const discountMinor = sumMinor(credits.map((l) => -l.amountMinor)); // credit amounts are stored negative
  const taxMinor = sumMinor(lines.map((l) => l.taxAmountMinor));
  const totalMinor = Math.max(0, subtotalMinor + taxMinor - discountMinor);
  return { subtotalMinor, discountMinor, taxMinor, totalMinor };
}

async function recomputeDraftTotals(tx: Tx, invoiceId: string) {
  const lines = await tx.billingInvoiceLine.findMany({ where: { invoiceId } });
  const t = computeTotals(lines);
  await tx.billingInvoice.update({ where: { id: invoiceId }, data: t });
  return t;
}

export interface GenerateInvoiceInput {
  organizationId: string;
  subscriptionId: string;
  planId: string;
  billingInterval: BillingInterval;
  billingPeriodId: string;
  billingName: string;
  billingEmail: string;
  idempotencyKey: string;
  generatedByUserId: string | null;
  now?: Date;
}

/**
 * Generate the DRAFT invoice for a billing period from the server-resolved
 * current price. Idempotent: if an invoice already exists for the period it is
 * returned unchanged. Returns null when the plan is not billable (no PlanPrice —
 * e.g. the grandfather plan), so renewal never fabricates a charge.
 */
export async function generateInvoiceForPeriod(tx: Tx, input: GenerateInvoiceInput) {
  const existing = await tx.billingInvoice.findUnique({ where: { billingPeriodId: input.billingPeriodId } });
  if (existing) return existing;

  const price = await resolveCurrentPrice(tx, input.planId, input.billingInterval, input.now);
  if (!price) return null; // non-billable plan (grandfather / NONE interval)

  const account = await getOrCreateBillingAccount(tx, input.organizationId, {
    billingName: input.billingName,
    billingEmail: input.billingEmail,
    currency: price.currency,
  });

  const lineAmount = price.amountMinor; // quantity 1
  const { taxAmountMinor, rateBps } = computeTaxMinor(lineAmount, price.taxCode);
  const totals = computeTotals([
    { type: "SUBSCRIPTION", amountMinor: lineAmount, taxAmountMinor },
  ]);

  const invoice = await tx.billingInvoice.create({
    data: {
      organizationId: input.organizationId,
      billingAccountId: account.id,
      subscriptionId: input.subscriptionId,
      billingPeriodId: input.billingPeriodId,
      status: "DRAFT",
      currency: price.currency,
      ...totals,
      generatedByUserId: input.generatedByUserId,
      idempotencyKey: input.idempotencyKey,
      lines: {
        create: [
          {
            type: "SUBSCRIPTION",
            description: `Subscription (${input.billingInterval.toLowerCase()})`,
            quantity: 1,
            unitAmountMinor: lineAmount,
            amountMinor: lineAmount,
            taxCode: price.taxCode,
            taxRateBps: rateBps,
            taxAmountMinor,
          },
        ],
      },
    },
  });
  await recordAuditEvent("commercial.billing.invoiceGenerated", input.generatedByUserId, { invoiceId: invoice.id, totalMinor: invoice.totalMinor, planId: input.planId }, { organizationId: input.organizationId }, tx);
  return invoice;
}

/** Platform-only: add a line to a DRAFT invoice (e.g. an add-on or adjustment). */
export async function addInvoiceLine(m: ActorMemberships, invoiceId: string, line: LineDraft) {
  requirePlatform(m);
  return prisma.$transaction(async (tx) => {
    const invoice = await tx.billingInvoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundError();
    if (!isInvoiceMutable(invoice.status)) throw new BadRequestError("This invoice is finalized and cannot be edited; use a credit or a new invoice.");
    if (line.quantity <= 0) throw new BadRequestError("quantity must be positive.");
    const amountMinor = line.quantity * line.unitAmountMinor;
    const { taxAmountMinor, rateBps } = computeTaxMinor(line.type === "CREDIT" ? 0 : Math.max(0, amountMinor), line.taxCode);
    await tx.billingInvoiceLine.create({
      data: {
        invoiceId, type: line.type, description: line.description, quantity: line.quantity,
        unitAmountMinor: line.unitAmountMinor, amountMinor, taxCode: line.taxCode ?? null,
        taxRateBps: rateBps, taxAmountMinor,
      },
    });
    await recomputeDraftTotals(tx, invoiceId);
    await recordAuditEvent("commercial.billing.invoiceLineAdded", m.userId, { invoiceId, type: line.type }, { organizationId: invoice.organizationId }, tx);
    return tx.billingInvoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { lines: true } });
  });
}

/**
 * Finalize a DRAFT invoice: assign its number atomically, freeze amounts, move to
 * OPEN. Idempotent-ish (a non-DRAFT invoice is returned unchanged). Runs in the
 * caller's transaction when provided (so renewal finalizes atomically), else its
 * own. Platform-authorized when called via the route; the `tx` overload is used
 * by internal renewal which has already authorized.
 */
export async function finalizeInvoiceTx(tx: Tx, invoiceId: string, actorUserId: string | null, dueInDays = 14, now: Date = new Date()) {
  const invoice = await tx.billingInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
  if (invoice.status !== "DRAFT") return invoice;
  if (invoice.invoiceNumber) return invoice;
  const fiscalYear = now.getFullYear();
  const seq = await nextInvoiceSequence(tx, fiscalYear);
  const number = formatInvoiceNumber(fiscalYear, seq);
  const dueAt = new Date(now.getTime() + dueInDays * 86_400_000);
  const status = invoice.totalMinor === 0 ? "PAID" : "OPEN";
  const updated = await tx.billingInvoice.update({
    where: { id: invoiceId },
    data: { status, invoiceNumber: number, finalizedAt: now, issuedAt: now, dueAt },
  });
  await recordAuditEvent("commercial.billing.invoiceFinalized", actorUserId, { invoiceId, invoiceNumber: number, totalMinor: updated.totalMinor }, { organizationId: invoice.organizationId }, tx);
  return updated;
}

/** Platform-only route entry to finalize. */
export async function finalizeInvoice(m: ActorMemberships, invoiceId: string) {
  requirePlatform(m);
  return prisma.$transaction((tx) => finalizeInvoiceTx(tx, invoiceId, m.userId), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20000, maxWait: 10000 });
}

/** Platform-only: void an invoice that has taken NO money. A paid invoice is corrected by a refund/credit, never a void. */
export async function voidInvoice(m: ActorMemberships, invoiceId: string, reason: string) {
  requirePlatform(m);
  return prisma.$transaction(async (tx) => {
    const invoice = await tx.billingInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
    if (invoice.status === "VOID") return invoice;
    if (invoice.amountPaidMinor > 0) throw new BadRequestError("This invoice has payments and cannot be voided; issue a refund or credit instead.");
    if (invoice.status === "PAID") throw new BadRequestError("A paid invoice cannot be voided.");
    const updated = await tx.billingInvoice.update({ where: { id: invoiceId }, data: { status: "VOID", voidedAt: new Date(), voidReason: reason } });
    await recordAuditEvent("commercial.billing.invoiceVoided", m.userId, { invoiceId, reason }, { organizationId: invoice.organizationId }, tx);
    return updated;
  });
}

/**
 * Recompute an invoice's payment status from its guarded amountPaidMinor running
 * total (maintained by the payment service). Never decreases a PAID invoice back
 * open on its own; refunds are tracked on the payment, not by rewriting invoice
 * status. Called inside the payment transaction.
 */
export async function refreshInvoicePaymentStatus(tx: Tx, invoiceId: string) {
  const invoice = await tx.billingInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
  if (invoice.status === "VOID" || invoice.status === "UNCOLLECTIBLE") return invoice;
  let status = invoice.status;
  if (invoice.amountPaidMinor >= invoice.totalMinor && invoice.totalMinor > 0) status = "PAID";
  else if (invoice.amountPaidMinor > 0) status = "PARTIALLY_PAID";
  else if (invoice.status === "PARTIALLY_PAID") status = "OPEN";
  if (status !== invoice.status) {
    return tx.billingInvoice.update({ where: { id: invoiceId }, data: { status } });
  }
  return invoice;
}

/** Tenant-scoped single read. */
export async function getInvoice(m: ActorMemberships, invoiceId: string) {
  const invoice = await prisma.billingInvoice.findUnique({
    where: { id: invoiceId },
    include: { lines: true, payments: true, credits: true },
  });
  if (!invoice) throw new NotFoundError();
  assertOrganizationAccess(m, invoice.organizationId); // 404-shaped for outsiders
  return invoice;
}

/** Tenant-scoped list for an organization. */
export async function listInvoices(m: ActorMemberships, organizationId: string) {
  assertOrganizationAccess(m, organizationId);
  return prisma.billingInvoice.findMany({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
    include: { lines: true },
  });
}

export { isInvoicePayable };
