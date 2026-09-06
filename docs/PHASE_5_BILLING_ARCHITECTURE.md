# Phase 5 — Billing + Insurance + Revenue Cycle Architecture

Builds a production-grade financial subsystem on top of the thin charge
engine Phase 0/4 established (`Charge` + `Bill`). `Bill`'s mutable
running-total counters are retired; every other model here is new. See
`docs/PHASE_5_FINANCIAL_INVARIANTS.md` for concurrency/money-safety detail,
`docs/PHASE_5_REVENUE_CYCLE.md` for the end-to-end provenance chain, and
`docs/PHASE_5_SCOPE_AND_DEFERRALS.md` for what's deliberately not built.

## 1. Money convention

Every monetary field is an integer minor unit — `xxxMinor Int` (INR
paise). Never a `Float`. Every money-anchoring row carries `currency
String @default("INR")`. All arithmetic goes through
`src/lib/hospital/billing/money.ts` (`rupeesToMinor`, `computeLineNetAmountMinor`,
`ceilStayDays`, etc.) — one rounding policy (round-half-up on integer
paise), used everywhere, never reimplemented per-route.

## 2. Data model

### Charge (extended)
`status: POSTED|VOIDED`. New fields: `chargeCode`, `quantity`,
`unitPriceMinor`, `discountMinor`, `netAmountMinor` (replaces the old
`amount: Float`), `postedByUserId`, void fields. `@@unique([sourceType,
sourceId])` (unchanged from Phase 0/4) is the charge-idempotency anchor.
Legal transition: `POSTED -> VOIDED` only, and only while not yet folded
into an issued `InvoiceLine` (`voidCharge` in `chargeCapture.ts`).

### BillingAccount (replaces `Bill`)
Pure grouping row (`encounterId @unique`, `status: OPEN|CLOSED`) — stores
**no totals**. `computeAccountSummary()` (`billingAccount.ts`) derives
every balance live from `Charge`/`Invoice`/`Payment`/`Refund`/
`FinancialAdjustment`, mirroring `dischargeBarrierEngine.ts`'s "don't
store what can go stale" philosophy — the exact anti-pattern that made the
old `Bill.totalAmount`/`paidAmount` counters untrustworthy.

### Tariff
Effective-dated price list entry: `(facilityId, payerId, chargeCode,
effectiveFrom, effectiveTo?)`. `facilityId` and `payerId` are **both
NOT NULL** — self-pay uses a seeded sentinel `Payer{type: CASH}` rather
than `payerId: null`, because a Postgres exclusion constraint over
nullable columns is awkward. Never overwrite historical pricing; a price
change is a new row. `pricing.ts#priceFor()` is the single deterministic
lookup used by every charge trigger.

### Payer / PayerPlan / PatientCoverage
Generic payer abstraction (`CASH|INSURANCE|GOVERNMENT_SCHEME|CORPORATE_TPA`),
not insurer-only. `PatientCoverage.priorityOrder` supports primary +
secondary payers; overlap of two ACTIVE primary coverages for the same
patient is rejected app-side (`coverage.ts#addPatientCoverage`).

### PreAuthorization
Foundation only — manual entry of the payer's decision, no live API. No
auto-expiry (`EXPIRED` is a status a human sets); staleness is a
live-computed warning (`preauth.ts#isPreAuthStale`), never an automatic
transition — this codebase has no cron/background job anywhere.

### InvoiceSequence / Invoice / InvoiceLine
`InvoiceSequence` is a per-`(facilityId, fiscalYear)` atomic counter
(`sequence.ts#nextSequence`), shared by both Invoice and Claim numbering
(`INV-2027-000042` / `CLM-2027-000043` style, same counter, different
prefix — this is deliberate, not a bug: the requirement was atomicity and
uniqueness, not separate number spaces). `Invoice.status: DRAFT ->
ISSUED -> {PARTIALLY_PAID, PAID} -> VOID` (VOID only from
ISSUED/PARTIALLY_PAID with zero allocated payments). Once `ISSUED`:
`invoiceNumber` and all four amount fields are frozen, every `InvoiceLine`
is immutable. `InvoiceLine.chargeId` is the provenance link back to the
originating `Charge`.

### Payment / PaymentAllocation
**Deposits are unallocated Payments, not a separate model** — "money
received with no invoice to apply it to yet" already is exactly what an
unallocated payment means; a parallel `Deposit` table would just duplicate
the ledger (see `deposits.ts`, a thin discoverability wrapper over
`recordPayment`). `idempotencyKey @unique` is the payment-race anchor.
`allocatedMinor`/`refundedMinor` are guarded running caches, CAS-updated
in the same transaction as the child row they summarize — not a blind
increment like the old `Bill.totalAmount`.

### Refund
References the original `Payment`, never mutates it. Maker-checker
enforced in code (`approvedByUserId` must differ from
`requestedByUserId`). **Scope note**: a refund targets only the
UNALLOCATED portion of a payment this phase — refunding money already
applied to an invoice requires a `FinancialAdjustment` on that invoice
first (deallocation isn't built; see scope-and-deferrals doc).

### FinancialAdjustment
`CREDIT_NOTE|DEBIT_NOTE|WRITE_OFF|DISCOUNT`, `PENDING -> APPROVED|REJECTED`.
Corrects an issued invoice without mutating it; once `APPROVED`,
immutable — a further correction is a new, opposite-direction adjustment.

### Claim / ClaimLine
One claim per invoice this phase (`Claim.invoiceId @unique` — split across
multiple payers explicitly deferred). `DRAFT -> SUBMITTED ->
{UNDER_REVIEW, REJECTED} -> {APPROVED, PARTIALLY_APPROVED, REJECTED} ->
SETTLED -> CLOSED`. No external payer/EDI integration — `recordClaimDecision`
is manual entry of what the payer said. Provenance needs no new table:
`ClaimLine.invoiceLineId -> InvoiceLine.chargeId -> Charge.sourceType/sourceId
-> <clinical order>` is already a complete chain (see revenue-cycle doc).
**Settlement vs. payment are separate steps**: `settleClaim` just records
the payer's final amount; the money actually arriving is a normal
`recordPayment` call with `method: INSURANCE_SETTLEMENT`, allocated to the
invoice like any other payment.

### PackageDefinition / PackageItem
Foundation only. Applying a package posts exactly **one** lump `Charge`
(`category: "PACKAGE"`, `sourceType: "PackageApplication"`). `PackageItem`
rows are display-only ("what's included") — no auto-explosion into
per-item charges, no consumption-matching against actual orders placed.

## 3. Service layer

```
src/lib/hospital/billing/
  money.ts            pure arithmetic/rounding — no DB
  sequence.ts         generic per-(facility,year) atomic counter
  billingAccount.ts    get-or-create + computeAccountSummary
  chargeCapture.ts     createCharge / createChargeIfNotExists / createPricedChargeIfNotExists / voidCharge
  pricing.ts           Tariff CRUD, overlap validation, priceFor()
  packages.ts          PackageDefinition/PackageItem CRUD + apply
  coverage.ts          Payer/PayerPlan/PatientCoverage CRUD
  preauth.ts           PreAuthorization CRUD + transitions
  invoices.ts          draft/addLine/issue/void, refreshInvoicePaymentStatus
  payments.ts          recordPayment (idempotent), allocatePayment (CAS), voidPayment
  deposits.ts          thin re-export of recordPayment (see Payment above)
  refunds.ts           requestRefund/approveRefund/completeRefund
  adjustments.ts        createAdjustment/approve/reject
  claims.ts            transition table + submit/decision/settle/close
  reconciliation.ts     4 live aggregate reads, nothing persisted
  financialClearance.ts computeFinancialClearance — informational only
```
`src/lib/hospital/billing.ts` is a thin re-export shim over
`billing/chargeCapture.ts` so the two pre-existing Phase 4 call sites
(`orders/lab`, `orders/imaging`) needed only updated arguments, not an
import-path change.

## 4. API routes

`/api/hospital/billing/{[encounterId], [encounterId]/charges/[chargeId]/void,
tariffs[/[id]], packages[/[id]/apply], adjustments[/[id]/approve|reject],
reconciliation}`, `/api/hospital/invoices[/[id][/lines][/issue][/void]]`,
`/api/hospital/payments[/[id]/allocate|void|refund, refunds/[id]/approve|complete|reject]`,
`/api/hospital/insurance/{payers[/[id]/plans], coverage[/[id]], preauth[/[id]]}`,
`/api/hospital/claims[/[id]/submit|decision|settle|close]`. All follow the
existing `requireFacilityStaff(permission, body?.facilityId ??
searchParams.get("facilityId"))` pattern, never expose Prisma models raw,
structured errors via `withApiErrors`/`BadRequestError`/`NotFoundError`.

## 5. RBAC

18 new permissions (`billing:*`, `insurance:*`) under a maker/checker
split across the two existing roles — no new `Role` enum value, matching
this codebase's "don't create duplicate roles" discipline. `BILLING_STAFF`
= maker tier (create/request). `HOSPITAL_ADMIN` = checker tier (void/
approve/manage pricing) **plus** every maker permission (an admin can do
everything billing staff can, plus approve). `AAROGYA_ADMIN` gets
oversight-only (tariff manage, reconciliation view, claim review).
`DOCTOR` keeps `billing:view` only — no new mutation permission.
`FRONT_DESK` gets none of the new permissions (had no billing permission
before either). Full list and exact grants in
`src/lib/auth/permissions.ts` under the `// Phase 5` comment block.

## 6. Audit

~27 new `AuditEventType` values under a `// Phase 5` comment block in
`src/lib/auth/audit.ts`. Every mutation route calls `recordAuditEvent`
with `{ facilityId, patientId, encounterId }` context where available,
following the exact Phase 4.5 pattern.

## 7. Clinical integrations

- **Pharmacy**: `dispenseMedication` (`medicationLifecycle.ts`) gained a
  charge hook after `dispensingRecord.create`, `sourceType:
  "DispensingRecord"`, priced via `chargeCode: "PHARMACY:<DRUGNAME>"`
  falling back to `PHARMACY:GENERIC`.
- **Admission/bed**: `finalizeDischarge` (`admission.ts`) posts one
  idempotent lump charge, `ceilStayDays()` (any partial day = full day),
  priced by `bed.ward.wardType` via `BED_DAY:<WardType>`. Mid-stay ward
  transfers are not separately priced this phase.
- **Discharge financial clearance**: `computeFinancialClearance`
  surfaced as an *additional*, non-blocking field on the discharge-
  barriers response — `billingReady`/`insuranceReady` remain the only
  flags that actually gate `finalizeDischarge`, unchanged.
- **Lab/imaging/manual billing**: switched from a raw client-trusted
  `amount` to server-priced `chargeCode` lookups, closing the
  amount-tampering gap. A raw `amountMinor` override on the manual route
  is only accepted with `billing:adjustment:approve` and a mandatory
  reason.

## 8. Migrations

SQLite: one migration (`20260907120000_phase5_billing_insurance_revenue_cycle`)
with hand-edited backfill SQL preserving existing `Charge`/`Bill` data
(rupees→paise conversion, one `BillingAccount` per pre-existing `Bill`).
Postgres: two migrations appended to `prisma/migrations-postgres-baseline/`
(the full schema delta, then the Tariff GiST exclusion constraint),
generated and validated against a real Postgres 16 instance following the
exact swap/validate/revert procedure from
`docs/PHASE_4_5_INTEGRITY_GATE.md`.
