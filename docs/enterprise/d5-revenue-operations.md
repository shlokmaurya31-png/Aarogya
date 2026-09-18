# D5 — revenue operations & canonical sources

Every metric maps to a canonical record. Currencies are NEVER summed together.

| Metric | Canonical source | Calculation | Scope |
| --- | --- | --- | --- |
| Invoiced | BillingInvoice | Σ totalMinor where finalizedAt ∈ [from,to) and status≠VOID, by currency | platform |
| Collected | BillingPayment | Σ amountMinor where succeededAt ∈ period, status∈{SUCCEEDED,PARTIALLY_REFUNDED,REFUNDED}, by currency | platform |
| Refunded | BillingRefund | Σ amountMinor (status SUCCEEDED) in period, currency from the payment | platform |
| Credited | BillingCredit | Σ amountMinor in period, by currency | platform |
| Outstanding | BillingInvoice | Σ invoiceOutstandingMinor over open invoices (current, not period), by currency | platform/org |
| Overdue | BillingInvoice | outstanding where dueAt < now | platform/org |
| Subscription states | OrganizationSubscription | groupBy status | platform |
| MRR/ARR | OrganizationSubscription + PlanPrice | see d5 (subscriptions) | platform |

## Authoritative outstanding (the ONE calculation)

`invoiceOutstandingMinor` (shared.ts): for OPEN/PARTIALLY_PAID/PAST_DUE →
max(0, totalMinor − amountPaidMinor); terminal states → 0. Credits are already
baked into totalMinor (D3); refunds are tracked on the payment and never
resurrect a settled invoice. Every screen and API uses this one function.

## Terminology (no false financial claims)

We say invoiced / collected / billed / outstanding / refunded / credited — never
"revenue", "profit", "recognized revenue" or "financial statements". The system
has no revenue-recognition accounting model. MRR/ARR are labelled a normalized
run-rate, explicitly not recognized revenue.

## Date & currency semantics

All windows are UTC, half-open [from, to), bounded server-side (default 30d, max
~400d) so no unbounded aggregation is possible. Inclusion rules: invoices by
finalizedAt, payments by succeededAt, refunds/credits by createdAt, outstanding
is current. Amounts are integer minor units; a currency dimension is always kept.

## MRR / ARR (IMPLEMENTED)

MRR = Σ monthly-normalized current PlanPrice over COMMITTED subscriptions
(ACTIVE/PAST_DUE/GRACE) with a resolvable price (MONTHLY as-is, QUARTERLY/3,
YEARLY/12), grouped by currency. ARR = MRR × 12. TRIAL and terminal states are
excluded. This is a run-rate, not recognized revenue.
