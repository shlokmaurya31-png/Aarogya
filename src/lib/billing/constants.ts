import type { BillingInvoiceStatus } from "@prisma/client";

/**
 * Phase D3 — SaaS billing lifecycle rules.
 *
 * Invoice transitions are an explicit allow-list; anything not listed is refused
 * by the invoice service. A finalized (non-DRAFT) invoice is financially
 * immutable — corrections are a credit/adjustment or a void+replacement, never an
 * in-place edit (mirrors the hospital revenue cycle's discipline, kept separate).
 */
export const INVOICE_TRANSITIONS: Record<BillingInvoiceStatus, BillingInvoiceStatus[]> = {
  DRAFT: ["OPEN", "VOID"],
  OPEN: ["PARTIALLY_PAID", "PAID", "PAST_DUE", "VOID", "UNCOLLECTIBLE"],
  PARTIALLY_PAID: ["PAID", "PAST_DUE", "VOID", "UNCOLLECTIBLE"],
  PAST_DUE: ["PARTIALLY_PAID", "PAID", "VOID", "UNCOLLECTIBLE"],
  // Terminal states.
  PAID: [],
  VOID: [],
  UNCOLLECTIBLE: [],
};

export function canTransitionInvoice(from: BillingInvoiceStatus, to: BillingInvoiceStatus): boolean {
  return INVOICE_TRANSITIONS[from]?.includes(to) ?? false;
}

/** A finalized invoice's amounts and lines are frozen; only DRAFT is mutable. */
export function isInvoiceMutable(status: BillingInvoiceStatus): boolean {
  return status === "DRAFT";
}

/** Statuses in which a payment can still be applied to an invoice. */
export function isInvoicePayable(status: BillingInvoiceStatus): boolean {
  return status === "OPEN" || status === "PARTIALLY_PAID" || status === "PAST_DUE";
}
