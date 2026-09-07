# Phase 6A — Cross-Module Integrity

## Concurrency mechanisms — one per required race, justified

The central design decision: `StockBalance.onHandQty`/`reservedQty` are
**Float accumulators**, not enum status columns — an observed-value-
equality CAS (`WHERE onHandQty = 5`) is the wrong tool (fragile on floats,
and the real guard needed is a *threshold*, not equality). Every quantity
mutation is instead a single **atomic conditional UPDATE** via
`tx.$executeRaw` (Prisma's fluent builder can't express a column-to-column
comparison like `onHandQty - reservedQty >= qty`):

```sql
UPDATE "StockBalance" SET "onHandQty" = "onHandQty" - $qty
WHERE id = $id AND ("onHandQty" - "reservedQty") >= $qty
```

One atomic statement — no read-then-write gap for a race to land in. A
concurrent second UPDATE targeting the same row blocks on the row lock,
then re-evaluates its own WHERE clause against the now-current row.
Correct identically on SQLite and Postgres, no explicit application-level
locking primitive needed.

| # | Race | Mechanism | Why this one |
|---|---|---|---|
| 1 | Last-5-units concurrent issue | Atomic conditional decrement on `StockBalance` (`onHandQty - reservedQty >= qty`), same transaction as the `StockLedgerEntry(ISSUE)` insert | Threshold check, not equality — the one correct primitive for a Float balance |
| 2 | Last-available-unit concurrent reservation | Same primitive against `reservedQty` | Reservation and issue are the same "reduce available by N" operation; an issue must already check availability inclusive of existing reservations, so the mechanism is naturally symmetric |
| 3 | Duplicate goods receipt (same PO line, 2 workers) | `GoodsReceipt.idempotencyKey` via raw `INSERT ... ON CONFLICT DO NOTHING`; separately, a ceiling-guarded raw UPDATE on `PurchaseOrderLine.receivedQuantity` (`WHERE orderedQuantity - receivedQuantity >= acceptedQty`) at approval time | The idempotency key for "this receiving submission" is a client session key on the header (like `Payment.idempotencyKey`), not `purchaseOrderLineId` alone (which would wrongly forbid legitimate multiple partial deliveries); the ceiling guard separately closes "two different, both-legitimately-recorded receipts, combined over-received" |
| 4 | Transfer race (competing transfer, same stock) | Same atomic conditional decrement as #1, at the source location's balance, on `initiateTransfer` | Identical shape to issue — a transfer consumes source-location availability |
| 5 | Duplicate transfer receipt | Guarded `updateMany` status CAS (`IN_TRANSIT → RECEIVED`, `count !== 1` throws) | Pure enum-status race — the same idiom `bed.ts`/`appointment.ts` already use, no raw SQL needed |
| 6 | Adjustment race | Normal-impact: atomic conditional update on `StockBalance`. High-impact: deferred to `approveAdjustment`, guarded by status CAS + same-actor check | Two different failure modes (float corruption vs. unauthorized approval) get the two mechanisms already proven for each |
| 7 | PO approval race | Guarded `updateMany` status CAS (`PENDING_APPROVAL → APPROVED`) + same-actor check | Identical shape to `Invoice`'s `DRAFT → ISSUED` guard from Phase 5 |
| 8 | Requisition approval race | Same guarded status CAS (`SUBMITTED → APPROVED`) + same-actor check | Same as #7 |

**No advisory locks anywhere in this phase.** Every race above reduces to
a single-row atomic UPDATE, a single-row status CAS, or a unique-
constraint-backed idempotent insert — all three are correct under
ordinary row locking and identical on SQLite. An advisory lock would only
be justified for a race spanning multiple rows with no single atomic
statement available — deliberately avoided here by the "one lot fulfills
one movement line" scope cut (see the Architecture doc).

**All 8 races verified with genuine `Promise.all` parallelism against a
real, disposable Postgres 16 container** (`scripts/verify-postgres-
inventory-concurrency.ts` for races 1/2/4/5/6, `scripts/verify-postgres-
procurement-concurrency.ts` for races 3/7/8) — 16/16 assertions passing,
including a genuine "two concurrently-approved receipts overselling one
PO line" scenario for race 3, and same-actor self-approval rejection as
an adversarial check.

## SQLite vs Postgres

Every mechanism above is standard SQL — identical code path, identical
guarantee, on both engines. The **one** new DB-level backstop this phase
introduces, `stocktake_one_in_progress_per_location` (a partial unique
index on `StockTake(facilityId, locationId) WHERE status='IN_PROGRESS'`),
is also portable — unlike the Tariff/ImagingResource GiST exclusion
constraints from Phases 4.5/5, no interval-overlap invariant exists
anywhere in this phase's data model, so no Postgres-only constraint was
needed. This is a deliberate simplification versus prior phases, not an
oversight — documented explicitly so a future session doesn't assume a
GiST constraint exists where it doesn't.

## Idempotency

Every user-facing action that could plausibly be retried (network blip,
double-click) carries a mandatory (non-nullable, `@unique`) `idempotencyKey`:
`StockReservation`, `StockTransfer`, `StockAdjustment`, `WasteRecord`,
`GoodsReceipt`, `PurchaseOrder`, `PurchaseRequisition`. All use the
**insert-first** pattern — the row is claimed via raw `INSERT ... ON
CONFLICT (idempotencyKey) DO NOTHING` *before* any balance is touched, so
a genuine concurrent double-submit only lets the winner of the insert race
proceed to mutate stock; the loser reads back the winner's row and returns
`alreadyExisted: true` without a second mutation. This is deliberately
different from `issueStock`'s own idempotency (see below), and the reason
is explained there.

`issueStock` (`inventory/issue.ts`) uses a **check-first** pattern instead
— `stockLedgerEntry.findFirst({sourceType, sourceId, movementType:
"ISSUE"})` before any mutation, backstopped by `postLedgerEntry`'s own
`ON CONFLICT DO NOTHING`. This mirrors the *existing* Phase 5 pharmacy
charge-hook's own idempotency boundary exactly (`createPricedChargeIfNotExists`,
keyed to a freshly-created `DispensingRecord.id`): both protect "the same
sourceId posted twice," not "a client-level retry of the whole outer
action" (a retry of `dispenseMedication` creates a *new* `DispensingRecord`
with a *new* id each time, since that row isn't itself idempotently
created — the existing Phase 3/5 architecture already accepted this
boundary for the charge hook, and this phase's stock issue inherits the
identical, already-accepted limitation rather than silently claiming a
stronger guarantee than the sibling mechanism it's paired with). A
genuine simultaneous double-call with the *identical* `sourceId` is
narrower than any of the 8 required races and isn't reachable by any
wired-up caller this phase (pharmacy dispensing always generates a fresh
`DispensingRecord.id` per attempt) — noted here as a known, deliberately-
scoped limitation, not a gap that was missed.

Every raw `INSERT ... ON CONFLICT DO NOTHING` in this phase follows the
exact cross-engine idiom `chargeCapture.ts#createChargeIfNotExists`
established in Phase 5 — never `create()` + catch P2002 (which aborts the
*entire* interactive transaction on Postgres, SQLSTATE 25P02, breaking any
same-transaction fallback read) and never Prisma's `createMany
({skipDuplicates})` (unsupported by the SQLite connector).

## Pharmacy integration — clinical and billing safety

`dispenseMedication()` (`medicationLifecycle.ts`) resolves the drug name
to an `Item` via `resolveItemForDrugName` **before** opening its
transaction — an unmapped drug throws `UnmappedDrugItemError` with
nothing created. Inside the existing single transaction, `issueStock` now
runs immediately after `DispensingRecord` creation and before the status
transitions and the (unchanged) charge hook. If stock is unavailable, or
the selected/FEFO lot is expired or quarantined, `issueStock` throws and
Prisma rolls back the **entire** transaction: no `DispensingRecord`
persists, no status change, and the charge hook — which runs later in the
same transaction — never executes. The order remains `VERIFIED`,
accurately reflecting the stock failure. This is the Clinical Safety
requirement ("a stock failure must never fabricate a dispense") satisfied
structurally by transaction atomicity, not by an additional application-
level check that could itself have a gap.

Provenance chain: `StockLedgerEntry(sourceType="DispensingRecord",
sourceId=record.id) ← DispensingRecord → Charge(sourceType=
"DispensingRecord", sourceId=record.id)` — both keyed off the same row,
so "what stock left the shelf" and "why was this billed" share one
anchor. Billing Safety is satisfied by construction: no new, independent
charge-creation path was added this phase; the existing Phase 5 charge
hook is untouched, still fires at most once per `DispensingRecord`
(`Charge`'s own `@@unique([sourceType, sourceId])`), and now additionally
depends on the stock issue succeeding first in the same transaction —
retrying the same stock event can produce at most one financial effect,
inherited directly from the mechanism Phase 5 already proved.

`GET /api/hospital/inventory/reports/reconciliation` is the live proof
surface for "the ledger is authoritative" — it was exercised end-to-end in
`scripts/verify-inventory-e2e.ts` against a dedicated, fully self-
contained item (receipt-equivalent → dispense → waste → stocktake
variance → adjustment), confirming `SUM(onHandDelta)` from the ledger
matches the stored balance exactly at every step, including after a
stocktake-driven adjustment.

## Bugs found

| Symptom | Root cause | Impact | Fix | Regression test |
|---|---|---|---|---|
| A caller correctly scoped to their own facility (via `requireFacilityStaff`) could pass another facility's `itemId`/`locationId`/`lotId`/`supplierId`/`purchaseOrderLineId` and have it silently accepted | No stock-mutating service function re-derived facility ownership from client-suppliable resource IDs — only the route layer's own `facilityId` resolution was trusted, and nothing cross-checked the *other* IDs in the request body against it | High — cross-tenant data integrity violation (a `StockBalance` row mixing Facility A's item with Facility B's location), and an IDOR information leak (existence of another facility's resources confirmable by ID) | Added `inventory/facilityScope.ts` (`assertItemInFacility`/`assertLocationInFacility`/`assertLotInFacility`/`assertSupplierInFacility`/`assertPurchaseOrderInFacility`/`assertPurchaseOrderLineInFacility`); wired into every affected entry point (`issueStock`, `reserveStock`, `initiateTransfer`, `createAdjustment`, `recordWaste`, `startStockTake`, `addStockTakeLine`, `addPurchaseOrderLine`, `addRequisitionLine`, `createRequisitionDraft`, `createPurchaseOrderDraft`, `recordGoodsReceipt`, `items.ts#createItem`'s `preferredSupplierId`) before any balance/ledger mutation | `scripts/verify-inventory-security.ts` — 8 adversarial assertions, including 4 direct cross-facility-ID rejection cases, all passing |
| `requisitionNumber`/`orderNumber`/`receiptNumber` were declared globally `@unique`, but the underlying sequence counters (`PurchaseRequisitionSequence`/`PurchaseOrderSequence`/`GoodsReceiptSequence`) are keyed `(facilityId, fiscalYear)` and reset per facility | Two facilities both issuing their first document of the year would both format to e.g. `"REQ-2026-000001"` and collide on a global unique index | Medium — discovered live via the multi-facility seed script; a second facility's requisition submission would hard-fail with a Postgres/SQLite unique-constraint error | Changed all three to `@@unique([facilityId, <number>])`, matching how the number is actually generated; added migration `20260907040000_phase6a_facility_scoped_document_numbers` | Seed script (`prisma/seedData/hospitalPhase6a.ts`) now successfully drives the full requisition→PO→receipt chain for a second facility in the same run; re-verified after the fix |
| `createAdjustment`/`recordWaste` classify by `Math.abs(delta) >= threshold` — a test fixture using exactly the threshold value (50) silently went to the `PENDING_APPROVAL` branch instead of posting immediately | Not a product bug — a fixture-authoring mistake in this phase's own E2E verification script, caught by the script's own assertions failing | Low — test-only, no production code path affected | Adjusted fixture quantities to stay clearly below/above the threshold as intended | `scripts/verify-inventory-e2e.ts` re-run clean after the fix |

## Known limitation: live browser verification of the new UI pages

`/hospital-os/inventory` and `/hospital-os/inventory/procurement` (plus
the "Inventory" nav group in `HospitalShell.tsx`) are confirmed correct by
every static check available: `tsc --noEmit` clean, `npm run build`
succeeds and lists both routes, and the compiled production JS chunks
were directly inspected and contain the new component markup and nav
labels. However, live browser verification (Claude in Chrome) was
**inconclusive**: both a fresh `next dev` server (after a full `.next`
cache wipe) and a fresh `next start` production server served an
`/hospital-os` response that omitted **both** the new Inventory nav group
**and** the pre-existing Diagnostics nav group (a Phase 4 feature this
phase never touched), while the compiled chunk on disk verifiably
contains both. This was investigated at length — process identity/start
time confirmed, no service worker registered, `.next` deleted and
rebuilt, `cache: 'no-store'` fetch performed directly in the page context
— without finding the cause. Given the pre-existing Diagnostics group is
equally affected, this points to a rendering anomaly in this local
environment (Next.js 16.2.10 canary, Windows, a project path containing a
space) rather than a defect in this phase's code, but it was **not**
possible to positively confirm the new pages render correctly in an
actual browser this session. Flagged explicitly rather than silently
claimed as verified — a future session should re-check this with a clean
environment (or a different Next.js version) before relying on the live
UI.

## Remaining risks

**Must fix before production:**
- The UI live-render anomaly above must be root-caused and confirmed
  resolved before the Inventory/Procurement screens are relied upon by
  real users.

**Should fix before Phase 6B:**
- No dedicated "Procurement Officer" role — `HOSPITAL_ADMIN` alone holds
  every procurement approval permission, mitigated only by a service-level
  same-actor guard (see Procurement doc).
- `dispenseMedication`'s inventory-issue idempotency is narrower than the
  8-race-tested mechanisms (see Idempotency section above) — acceptable
  because it mirrors an already-shipped Phase 5 pattern, but worth
  revisiting if pharmacy dispensing ever needs true client-retry safety.

**Infra blockers:** none newly identified this phase.

**Future feature work (explicitly out of scope, not started):** no
item cost/valuation model, no automatic purchasing, no Lab/Radiology
consumption UI, no live supplier/ERP integration, no serial-number
tracking beyond the `trackSerial` flag, no OT/ICU/Blood Bank/Workforce/
Facilities work — per the brief's explicit Critical Stop Rule.
