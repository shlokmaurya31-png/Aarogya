import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { sumMinor } from "./money";
import { getOrCreateBillingAccount } from "./billingAccount";
import { nextSequence, formatSequenceNumber } from "./sequence";
import { textContains } from "@/lib/search";
import { closeTask, OPEN_STATUSES } from "@/lib/hospital/task";
import { facilityOrganizationId } from "@/lib/events/tenant";
import { resolveEffectiveInternal } from "@/lib/config/resolver";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";

type Tx = Prisma.TransactionClient;

export class InvoiceConcurrencyError extends BadRequestError {
  constructor(action: string) {
    super(`Invoice was already ${action} by someone else, or is no longer in the expected state. Refresh and try again.`);
  }
}

export class InvoiceNotDraftError extends BadRequestError {
  constructor() {
    super("Invoice lines can only be added while the invoice is still DRAFT.");
  }
}

export class InvoiceHasPaymentsError extends BadRequestError {
  constructor() {
    super("This invoice has allocated payments and cannot be voided — issue a financial adjustment instead.");
  }
}

const ALLOWED: Record<string, string[]> = {
  DRAFT: ["ISSUED", "VOID"],
  ISSUED: ["PARTIALLY_PAID", "PAID", "VOID"],
  PARTIALLY_PAID: ["PAID", "VOID"],
  PAID: [],
  VOID: [],
};

export function isInvoiceTransitionAllowed(from: string, to: string): boolean {
  return (ALLOWED[from] ?? []).includes(to);
}

/** Creates a new DRAFT invoice anchored to the encounter's BillingAccount. Multiple DRAFT invoices per account are legal (e.g. billing an interim period vs. the final stay). */
export async function draftInvoiceForAccount(
  tx: Tx,
  input: { encounterId: string; patientId: string; facilityId: string; payerId?: string | null; generatedByUserId: string }
) {
  const account = await getOrCreateBillingAccount(tx, { encounterId: input.encounterId, patientId: input.patientId, facilityId: input.facilityId });
  return tx.invoice.create({
    data: {
      billingAccountId: account.id,
      encounterId: input.encounterId,
      patientId: input.patientId,
      facilityId: input.facilityId,
      payerId: input.payerId ?? null,
      generatedByUserId: input.generatedByUserId,
    },
  });
}

async function recalculateDraftTotals(tx: Tx, invoiceId: string, invoiceLevelDiscountMinor: number, taxRatePercent: number) {
  const lines = await tx.invoiceLine.findMany({ where: { invoiceId }, select: { netAmountMinor: true } });
  const subtotalMinor = sumMinor(lines.map((l) => l.netAmountMinor));
  const discountMinor = Math.min(invoiceLevelDiscountMinor, subtotalMinor);
  const taxableMinor = subtotalMinor - discountMinor;
  const taxMinor = Math.round((taxableMinor * taxRatePercent) / 100);
  const totalMinor = taxableMinor + taxMinor;
  await tx.invoice.update({ where: { id: invoiceId }, data: { subtotalMinor, discountMinor, taxMinor, totalMinor } });
  return { subtotalMinor, discountMinor, taxMinor, totalMinor };
}

/**
 * Keep a DRAFT invoice line in step with its charge after the charge is priced
 * or waived (an issued line is never edited: the charge can't change then).
 */
export async function syncDraftLineForCharge(tx: Tx, chargeId: string) {
  const charge = await tx.charge.findUniqueOrThrow({ where: { id: chargeId }, include: { invoiceLine: { include: { invoice: { select: { id: true, status: true } } } } } });
  const line = charge.invoiceLine;
  if (!line) return;
  if (line.invoice.status !== "DRAFT") throw new InvoiceNotDraftError();
  await tx.invoiceLine.update({ where: { id: line.id }, data: { description: charge.description, unitPriceMinor: charge.unitPriceMinor, netAmountMinor: charge.netAmountMinor } });
  await recalculateDraftTotals(tx, line.invoice.id, 0, 0);
}

export class InvoiceNeedsPricingError extends BadRequestError {
  constructor(count: number) {
    super(`${count} line(s) on this invoice still need pricing. Price or waive them before issuing.`);
  }
}

/** Pulls an un-invoiced POSTED charge for the same encounter onto this DRAFT invoice as a new line. A charge can appear on at most one invoice ever (InvoiceLine.chargeId is unique). */
export async function addChargeToInvoice(tx: Tx, invoiceId: string, chargeId: string) {
  const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  if (invoice.status !== "DRAFT") throw new InvoiceNotDraftError();

  const charge = await tx.charge.findUniqueOrThrow({ where: { id: chargeId }, include: { invoiceLine: true } });
  if (charge.encounterId !== invoice.encounterId) throw new BadRequestError("Charge belongs to a different encounter than this invoice.");
  if (charge.status !== "POSTED") throw new BadRequestError("Only POSTED charges can be invoiced.");
  if (charge.invoiceLine) throw new BadRequestError("This charge is already on an invoice.");

  await tx.invoiceLine.create({
    data: {
      invoiceId,
      chargeId: charge.id,
      description: charge.description,
      quantity: charge.quantity,
      unitPriceMinor: charge.unitPriceMinor,
      netAmountMinor: charge.netAmountMinor,
    },
  });

  await recalculateDraftTotals(tx, invoiceId, 0, 0);
  return tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { lines: true } });
}

/** `billing.late_charge.document_type` for the facility: SUPPLEMENTARY_INVOICE (default) or DEBIT_NOTE. */
export async function lateChargeDocumentType(facilityId: string): Promise<"SUPPLEMENTARY_INVOICE" | "DEBIT_NOTE"> {
  const organizationId = await facilityOrganizationId(prisma, facilityId);
  const { value } = await resolveEffectiveInternal({ key: "billing.late_charge.document_type", organizationId, facilityId });
  return value === "DEBIT_NOTE" ? "DEBIT_NOTE" : "SUPPLEMENTARY_INVOICE";
}

/**
 * Batch 5, decision 2: collect an encounter's charges that are on no invoice
 * (the late ones) onto a new DRAFT document linked to the issued original. The
 * original is never edited. The document type follows the facility's
 * `billing.late_charge.document_type`.
 */
export async function draftSupplementaryInvoice(tx: Tx, input: { originalInvoiceId: string; generatedByUserId: string }) {
  const original = await tx.invoice.findUniqueOrThrow({ where: { id: input.originalInvoiceId } });
  if (original.documentType !== "INVOICE") throw new BadRequestError("Supplement the original invoice, not a supplementary document.");
  if (!["ISSUED", "PARTIALLY_PAID", "PAID"].includes(original.status)) throw new BadRequestError("Only an issued invoice can be supplemented; add the charges to the draft instead.");
  const pending = await tx.charge.findMany({ where: { encounterId: original.encounterId, status: "POSTED", invoiceLine: null }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true } });
  if (!pending.length) throw new BadRequestError("This encounter has no un-invoiced charges to collect.");
  const supplementary = await tx.invoice.create({
    data: {
      billingAccountId: original.billingAccountId, encounterId: original.encounterId, patientId: original.patientId, facilityId: original.facilityId,
      payerId: original.payerId, generatedByUserId: input.generatedByUserId,
      documentType: await lateChargeDocumentType(original.facilityId), supplementsInvoiceId: original.id,
    },
  });
  for (const c of pending) await addChargeToInvoice(tx, supplementary.id, c.id);
  return tx.invoice.findUniqueOrThrow({ where: { id: supplementary.id }, include: { lines: true } });
}

const NUMBER_PREFIX = { INVOICE: "INV", SUPPLEMENTARY_INVOICE: "SUP", DEBIT_NOTE: "DN" } as const;

/** Guarded DRAFT -> ISSUED: assigns invoiceNumber atomically via the fiscal-year sequence and freezes totals. Losing a concurrent double-issue attempt gets InvoiceConcurrencyError, never a duplicate number. */
export async function issueInvoice(
  tx: Tx,
  invoiceId: string,
  input: { discountMinor?: number; taxRatePercent?: number; dueAt?: Date; byUserId?: string | null }
) {
  const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { lines: true } });
  if (invoice.status !== "DRAFT") throw new InvoiceNotDraftError();
  if (invoice.lines.length === 0) throw new BadRequestError("Cannot issue an invoice with no lines.");
  // Batch 5: never issue a zero line that was only waiting for a price.
  const unpriced = await tx.charge.count({ where: { invoiceLine: { invoiceId }, pricingStatus: "NEEDS_PRICING" } });
  if (unpriced > 0) throw new InvoiceNeedsPricingError(unpriced);

  const totals = await recalculateDraftTotals(tx, invoiceId, input.discountMinor ?? 0, input.taxRatePercent ?? 0);

  const fiscalYear = new Date().getFullYear();
  const seq = await nextSequence(tx, { facilityId: invoice.facilityId, fiscalYear });
  const invoiceNumber = formatSequenceNumber(NUMBER_PREFIX[invoice.documentType], fiscalYear, seq);

  const result = await tx.invoice.updateMany({
    where: { id: invoiceId, status: "DRAFT" },
    data: { status: "ISSUED", invoiceNumber, issuedAt: new Date(), dueAt: input.dueAt, ...totals },
  });
  if (result.count !== 1) throw new InvoiceConcurrencyError("issued");
  await emitFacilityEvent(tx, {
    type: "HospitalInvoiceIssued", aggregateId: invoice.id, facilityId: invoice.facilityId, encounterId: invoice.encounterId, actorUserId: input.byUserId ?? null,
    payload: {
      invoiceId: invoice.id, encounterId: invoice.encounterId, patientId: invoice.patientId, totalMinor: totals.totalMinor, currency: invoice.currency,
      lineCount: invoice.lines.length, documentType: invoice.documentType,
      ...(invoice.supplementsInvoiceId ? { supplementsInvoiceId: invoice.supplementsInvoiceId } : {}),
    },
  });
  // Late charges now collected: their billing exception tasks are done.
  const late = invoice.lines.map((l) => l.chargeId).filter((id): id is string => !!id).map((id) => `LATE_CHARGE:${id}`);
  if (late.length) {
    const tasks = await tx.task.findMany({ where: { facilityId: invoice.facilityId, idempotencyKey: { in: late }, status: { in: OPEN_STATUSES } }, select: { id: true } });
    for (const t of tasks) await closeTask(tx, t.id, "COMPLETED", { completedAt: new Date() });
  }
  return tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { lines: true } });
}

/** Only legal from ISSUED/PARTIALLY_PAID with ZERO allocated payments — otherwise a FinancialAdjustment is the correct tool, never a void of a paid invoice. */
export async function voidInvoice(tx: Tx, invoiceId: string, input: { reason: string; byUserId: string }) {
  const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { allocations: true } });
  if (!isInvoiceTransitionAllowed(invoice.status, "VOID")) throw new BadRequestError(`Cannot void an invoice in status ${invoice.status}.`);
  if (invoice.allocations.length > 0) throw new InvoiceHasPaymentsError();

  const result = await tx.invoice.updateMany({
    where: { id: invoiceId, status: invoice.status },
    data: { status: "VOID", voidedAt: new Date(), voidedByUserId: input.byUserId, voidReason: input.reason },
  });
  if (result.count !== 1) throw new InvoiceConcurrencyError("voided");
  await emitFacilityEvent(tx, {
    type: "HospitalInvoiceVoided", aggregateId: invoice.id, facilityId: invoice.facilityId, encounterId: invoice.encounterId, actorUserId: input.byUserId,
    payload: {
      invoiceId: invoice.id, encounterId: invoice.encounterId, patientId: invoice.patientId, from: invoice.status,
      totalMinor: invoice.totalMinor, currency: invoice.currency, documentType: invoice.documentType,
    },
  });
  return tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
}

/**
 * Called by payments.ts after an allocation posts, inside the same
 * transaction — recomputes ISSUED/PARTIALLY_PAID/PAID from
 * Invoice.allocatedMinor, the guarded running total allocatePayment
 * atomically maintains (see payments.ts), rather than re-summing
 * PaymentAllocation rows — one source of truth, no second aggregate query.
 */
export async function refreshInvoicePaymentStatus(tx: Tx, invoiceId: string) {
  const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  if (invoice.status !== "ISSUED" && invoice.status !== "PARTIALLY_PAID") return invoice;
  const nextStatus = invoice.allocatedMinor >= invoice.totalMinor ? "PAID" : invoice.allocatedMinor > 0 ? "PARTIALLY_PAID" : "ISSUED";
  if (nextStatus === invoice.status) return invoice;
  return tx.invoice.update({ where: { id: invoiceId }, data: { status: nextStatus } });
}

export async function findInvoiceInFacility(invoiceId: string, facilityId: string) {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { lines: true } });
  if (!invoice || invoice.facilityId !== facilityId) throw new NotFoundError("Invoice not found.");
  return invoice;
}

/**
 * The invoice list filter (GET /api/hospital/invoices). One builder for both
 * the page query and its count, so `total` always counts what the page lists,
 * including the invoice-number search.
 */
export function invoiceListWhere(
  facilityId: string,
  filters: { status?: string; patientId?: string; encounterId?: string; invoiceNumber?: string }
): Prisma.InvoiceWhereInput {
  return {
    facilityId,
    status: filters.status as Prisma.InvoiceWhereInput["status"],
    patientId: filters.patientId,
    encounterId: filters.encounterId,
    invoiceNumber: filters.invoiceNumber ? textContains(filters.invoiceNumber) : undefined,
  };
}
