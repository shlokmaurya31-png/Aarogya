# Phase 5 — Revenue Cycle: Provenance Chain and Worked Example

## The provenance chain

Every financial amount in this system can be traced back through an
unbroken FK chain to the clinical event that generated it:

```
Clinical event (LabOrder / ImagingOrder / DispensingRecord / Admission)
    ↓ sourceType + sourceId
Charge (netAmountMinor, chargeCode)
    ↓ InvoiceLine.chargeId
InvoiceLine (on an issued Invoice)
    ↓ ClaimLine.invoiceLineId
ClaimLine (on a Claim, if insurance)
    ↓ Claim.status / approvedAmountMinor / settledAmountMinor
Payer decision
    ↓ Payment.method = INSURANCE_SETTLEMENT, PaymentAllocation.invoiceId
Payment received
```

No step in this chain requires a join through free-text `detail` JSON —
every link is a real foreign key. This answers, for any invoiced amount:
"why is this ₹X being charged/claimed?" and "which clinical event
ultimately produced it?"

## Worked example (from the live verification pass)

1. **Lab order placed** (no catalog link, freeform test name) →
   `chargeResult = createPricedChargeIfNotExists(..., chargeCode:
   "LAB:GENERIC")` → `Charge{netAmountMinor: 30000, sourceType: "LabOrder",
   sourceId: <order.id>}`.
2. **Imaging order placed** (freeform) → `Charge{netAmountMinor: 150000,
   chargeCode: "IMAGING:GENERIC", sourceType: "ImagingOrder"}`.
3. **Invoice drafted** for the encounter → both charges added as
   `InvoiceLine`s → **issued** with a ₹100 discount and 5% tax:
   `subtotalMinor 180000 → discountMinor 10000 → taxMinor 8500 →
   totalMinor 178500`, `invoiceNumber: "INV-2026-000002"`.
4. **Payment recorded** (`CASH`, `amountMinor: 178500`,
   `idempotencyKey`) → **allocated** in full to the invoice → invoice
   auto-transitions `ISSUED → PAID` (`refreshInvoicePaymentStatus`,
   driven by the actual allocation sum, never a separately-set flag).
5. **Idempotency retry**: re-posting the identical payment request with
   the same `idempotencyKey` returns the same `Payment` row,
   `alreadyExisted: true` — no double posting.
6. **Insurance claim** drafted against the same invoice using the
   patient's pre-existing `PatientCoverage` → `ClaimLine`s mirror the two
   `InvoiceLine`s exactly (`claimedAmountMinor` 30000 and 150000) →
   **submitted** (`claimNumber: "CLM-2026-000003"` — same fiscal-year
   sequence counter as the invoice, just a different prefix) →
   **UNDER_REVIEW** → **APPROVED** (`approvedAmountMinor: 170000`) →
   **SETTLED** (`settledAmountMinor: 170000`).
7. **Reconciliation** for the period correctly shows: gross charges
   ₹28,801 (all facility activity in range), invoiced ₹2,285, collected
   ₹2,035, one claim SETTLED for ₹1,800 in the 0–7-day aging bucket,
   ₹250 still outstanding self-pay from an unrelated seeded invoice.

Every number above was produced by live HTTP calls against a running dev
server during Phase 5's verification pass, not asserted in the abstract —
see `docs/PHASE_5_FINANCIAL_INVARIANTS.md` for the concurrency-specific
verification and the bug it found.

## Refunds and deposits in the chain

A **deposit** is a `Payment` with zero `PaymentAllocation` rows —
verified live: recorded a ₹500 UPI payment with no `invoiceId`, then
requested a ₹200 refund against it (rejected once for exceeding the
refundable balance in a first over-refund attempt, then accepted at a
valid amount), which went through the full maker-checker lifecycle
(`REQUESTED` by billing staff → same-role self-approval correctly
blocked by RBAC → `APPROVED` by a different admin user → `COMPLETED`,
`Payment.refundedMinor` updated via the same CAS mechanism used for
allocation).

## What reconciliation actually computes

Four on-demand aggregate reads (`src/lib/hospital/billing/reconciliation.ts`),
nothing persisted or scheduled:

- **Collection by method**: `Σ Payment.amountMinor` (status=RECEIVED, in
  range) minus `Σ Refund.amountMinor` (status=COMPLETED, in range),
  grouped by method.
- **Outstanding by payer**: `Σ Invoice.totalMinor − Σ allocations` for
  ISSUED/PARTIALLY_PAID invoices, grouped by `payerId` (self-pay grouped
  under a synthetic `SELF_PAY` key).
- **Charge → invoice → collection leakage**: three numbers
  (`grossChargesMinor`, `invoicedMinor`, `collectedMinor`) that directly
  expose the exact failure mode the old `Bill` mutable counter could
  silently hide — a charge posted but never folded into any invoice.
- **Claim aging**: count and amount by status × days-since-submission
  bucket (0–7 / 8–30 / 31+ / unsubmitted).
