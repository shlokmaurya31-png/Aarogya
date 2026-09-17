# Invoicing & tax (Phase D3)

## Invoices

`BillingInvoice` + `BillingInvoiceLine`. Amounts are ALWAYS computed server-side
from the resolved `PlanPrice` and the lines (`computeTotals`); a client never
supplies a price, tax, discount or total.

Lifecycle: `DRAFT → OPEN → PARTIALLY_PAID → PAID`, with `PAST_DUE`, `VOID` and
`UNCOLLECTIBLE`. Transitions are an explicit allow-list (`constants.ts`).

- **DRAFT** is the only mutable state.
- **Finalize** (`DRAFT → OPEN`) assigns the invoice number atomically and freezes
  the number, every amount and every line. A zero-total invoice finalizes to
  `PAID`.
- After finalize the invoice is immutable: no line/price/quantity/total edits.
  Corrections are a credit, a `FinancialAdjustment`-style credit note, or a
  void + replacement — never an in-place edit.
- **Void** is allowed only when no money has been applied; a paid invoice is
  corrected by a refund/credit, never voided.

## Numbering

`AAR-SAAS-<fiscalYear>-<000000>` via a per-fiscal-year CAS counter
(`BillingInvoiceSequence`), platform-wide, deterministic, server-generated. A
client-supplied number is never trusted.

## Tax — a BOUNDARY only

`tax.ts` maps a `taxCode` to a rate in basis points and computes tax once on the
taxable amount. This is a foundation, NOT an Indian tax engine: the rate table
has a single seeded entry (`GST_18` = 18%), an unknown code resolves to 0 (never
a guess), and D3 makes NO compliance claim. Place-of-supply, CGST/SGST/IGST
split, HSN/SAC and filing are explicitly out of scope.
