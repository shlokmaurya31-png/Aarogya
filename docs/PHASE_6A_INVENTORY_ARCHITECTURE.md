# Phase 6A — Inventory Architecture

A reusable physical-stock engine for the Hospital OS, built from a
confirmed-clean slate: a repo-wide audit before this phase found zero
pre-existing inventory/stock/procurement code anywhere — the only
inventory-adjacent fields in the whole codebase were `DispensingRecord
.batchNumber`/`.expiryDate`, free-text bookkeeping on a dispense-log row
with no relation to any batch/lot/location entity and no stock balance
tracked anywhere.

## Item master — reusable, not medication-only

`Item` (`prisma/schema.prisma`) is a physical-stock concept: `sku` (unique),
`name`, `category` (`MEDICATION | CONSUMABLE | SURGICAL_SUPPLY |
LAB_REAGENT | RADIOLOGY_CONSUMABLE | IMPLANT | EQUIPMENT | BLOOD_PRODUCT |
OTHER`), `baseUnit` (the one `UnitOfMeasure` every ledger/balance row for
this item is recorded in), `trackLots`/`trackExpiry`/`trackSerial` flags,
and reorder configuration. `facilityId` is nullable — a null-facility item
is a global/org-wide catalog entry, mirroring the existing `LabTestCatalog`
convention rather than inventing a new pattern. No medication-clinical
fields (dose, route, frequency) are duplicated onto `Item`.

## Item / medication separation

A medication is a clinical concept (`MedicationOrder.drugName`, still
freeform text, unchanged this phase); an inventory item is a physical
stock concept (manufacturer, batch, expiry, quantity). These are
deliberately not collapsed into one model. `MedicationItemLink`
(`facilityId?`, `drugNameKey`, `itemId`, `@@unique([facilityId,
drugNameKey])`) is the explicit, optional bridge — `drugNameKey` uses the
exact same `.trim().toUpperCase()` normalization `medicationLifecycle.ts`
already applied for its Phase 5 pharmacy charge code, so there is one
normalization convention, not two. A facility-scoped link takes precedence
over a global one. If a drug has no link, dispensing is blocked with
`UnmappedDrugItemError` — the inventory engine is authoritative, so an
unmapped drug is a configuration gap to fix, not a silent bypass.

## Units of measure

An explicit `UnitOfMeasure` enum (`TABLET/CAPSULE/VIAL/AMPOULE/BOTTLE/BOX/
PACK/PIECE/ML/MG/GRAM/KG/LITER/OTHER`), never an arbitrary string.
`inventory/units.ts` groups units into dimensions (COUNT/MASS/VOLUME/
OTHER — `OTHER` is compatible only with itself) and `ItemUnitConversion`
(`itemId`, `unit`, `baseUnitsPerUnit`) supplies the actual per-item factor
(e.g. "1 BOX = 100 TABLET" is specific to one item, not a global
constant). `convertToBaseUnit` throws `IncompatibleUnitError` or
`UnitConversionNotConfiguredError` rather than guessing — this codebase's
established discipline (see `billing/money.ts`'s discount-can't-exceed-
gross guard) is to reject ambiguous input, never silently coerce it. No
general unit-conversion engine was built — this is the minimum reliable
foundation the brief asked for.

## Storage locations

`StockLocation` (`facilityId`, `name`, `type` — `WAREHOUSE/STORE/PHARMACY/
OT_STORE/LAB_STORE/RADIOLOGY_STORE/WARD_STORE/BIN/OTHER`,
`parentLocationId?` self-relation) forms a Facility → Store → Bin
hierarchy. A stock balance never exists without a `locationId` — there is
no "unlocated" stock concept anywhere in the schema.

## Lot/batch

`ItemLot` (`itemId`, `facilityId`, `lotNumber`, `manufacturer?`,
`manufacturedAt?`, `expiresAt?`, `status` — `ACTIVE/QUARANTINED/EXPIRED/
RECALLED/DEPLETED`) is never physically deleted. For `trackLots=false`
items, a sentinel `"NO-LOT"` lot (never expires) is get-or-created
(`inventory/lots.ts#getOrCreateNoLotSentinel`) rather than making `lotId`
nullable on the ledger/balance — one code path handles both tracked and
untracked items, instead of branching the whole stock model on
nullability.

## Expiry

First-class, not a UI filter. `isExpired`/`isExpiringSoon` are pure
functions (`inventory/expiry.ts`). Expiry state transitions lazily on
read: `ensureLotExpiryState` flips an `ACTIVE` lot whose `expiresAt` has
passed to `EXPIRED` the next time any stock-affecting service touches it
(there is no cron/background job anywhere in this codebase, by
established convention). An admin-triggered manual sweep route (`POST
/api/hospital/inventory/lots/expiry-sweep`) additionally keeps the
Expiring-Soon/Expired dashboards accurate for lots nobody has recently
transacted against. Server-side issue validation (`fefo.ts
#validateExplicitLot`) rejects an expired lot unconditionally — never
relies on the client filtering it out.

## Stock ledger — the authoritative core

`StockLedgerEntry` is append-only. Every material stock change is exactly
one row (a transfer is exactly two: `TRANSFER_OUT` + `TRANSFER_IN`). It is
enforced immutable **by convention** — no service code anywhere calls
`.update()` or `.delete()` on this model (verified in review, the same
discipline already applied to `Charge`/`PaymentAllocation` in Phase 5). A
correction is always a new, opposite-direction entry (an erroneous `ISSUE`
is corrected via a `RETURN`, never rewritten).

Two signed delta columns, not one: `onHandDelta` and `reservedDelta`.
`RECEIPT`/`ISSUE`/`WASTE`/`ADJUSTMENT`/`TRANSFER_*` move `onHandDelta`;
`RESERVATION`/`RELEASE` move only `reservedDelta`; an issue that consumes
a prior reservation (`reservation.ts#consumeReservation`) moves both in
one entry. `unit` denormalizes `item.baseUnit` at post time.

Idempotency key: `@@unique([sourceType, sourceId, movementType])`,
sufficient because of a deliberate scope cut — **one lot fulfills one
movement line** (no automatic multi-lot split-allocation on a single
issue/transfer/waste/adjustment), so `lotId` need not be part of the key.
Every write goes through the one `postLedgerEntry` function
(`inventory/ledger.ts`), which wraps a raw `INSERT ... ON CONFLICT DO
NOTHING` — the identical cross-engine idempotent-insert idiom as
`chargeCapture.ts#createChargeIfNotExists` from Phase 5, for the identical
reason: a failed `INSERT` inside an interactive transaction aborts the
whole transaction on Postgres (SQLSTATE 25P02), and `createMany
({skipDuplicates})` isn't supported by Prisma's SQLite connector at all.
`movementType`/`unit`/`wasteReason`/`adjustmentReason` are native Postgres
enum columns, injected as raw literals via `Prisma.raw()` rather than
`${}` bind parameters — the same proven `Payment.method` pattern from
Phase 5 (Postgres won't implicitly cast a bound text parameter to a
custom enum type).

## Stock balance — a derivable cache, not a second source of truth

`StockBalance` (`itemId`, `lotId`, `locationId`, `onHandQty`,
`reservedQty`, `@@unique([itemId, lotId, locationId])`) is materialized
for query performance. It is **never** hand-decremented
(`balance.onHandQty - 5`) anywhere in application code — every mutation
goes through one of the atomic conditional-UPDATE primitives in
`inventory/stockBalance.ts` (see `docs/PHASE_6A_INTEGRITY.md` for the full
concurrency justification). `GET /api/hospital/inventory/reports/
reconciliation` recomputes `SUM(onHandDelta)`/`SUM(reservedDelta)` from
the ledger, grouped by `(itemId, lotId, locationId)`, and diffs it against
the stored balance — the ledger is authoritative, the balance is
derivable, and this route is the standing proof of that invariant, not
just a design claim.

Stock position is explicitly `item + lot + location + unit`, never a bare
`item → quantity` map.

## FEFO — First-Expiry-First-Out

`inventory/fefo.ts#selectFefoLot` picks the earliest-non-expired-ACTIVE
lot with sufficient available quantity at a location. The eligibility
check (`isLotEligible`) and the sort comparator (`compareLotsForFefo`) are
both pure, exported functions — unit-tested directly
(`fefo.test.ts`, 11 cases: exact eligibility boundaries, expired-by-status,
expired-by-date-with-status-not-yet-flipped, insufficient-available,
reservation-reduces-available, earliest-expiry-wins, null-expiry-sorts-
last, deterministic tiebreak on `lotId` for equal/absent expiry dates).
Never returns an expired or quarantined lot. FEFO only *selects* a
candidate — it does not reserve or decrement anything itself; the caller
(`issue.ts`/`reservation.ts`) still goes through the atomic guarded
primitives, so a lot chosen here that loses a concurrent race to another
request simply surfaces as `InsufficientStockError`, never silent
corruption. An authorized caller can override FEFO with an explicit
`lotId` — still validated `ACTIVE`/not-expired/not-quarantined
unconditionally, even when explicitly selected (`validateExplicitLot`).

## Reservation

`StockReservation` reserves stock ahead of consumption (future OT/ICU/
procedure/pharmacy/blood-product use) — reduces `reservedQty`
(shrinking `available = onHandQty - reservedQty`), never `onHandQty`,
until released (`releaseReservation`) or consumed
(`consumeReservation`, which atomically converts reserved → issued via
`atomicConvertReservedToIssued`). `expiresAt` is staff-observed only,
never auto-transitioned — no cron exists in this codebase, the same
convention as `PreAuthorization.EXPIRED` from Phase 5.

## Facility isolation — enforced at the service layer, not just the route

Every stock-mutating service function (`issueStock`, `reserveStock`,
`initiateTransfer`, `createAdjustment`, `recordWaste`, `startStockTake`,
`addStockTakeLine`, `addPurchaseOrderLine`, `addRequisitionLine`,
`createRequisitionDraft`, `createPurchaseOrderDraft`,
`recordGoodsReceipt`) calls into `inventory/facilityScope.ts`
(`assertItemInFacility`/`assertLocationInFacility`/`assertLotInFacility`/
`assertSupplierInFacility`/`assertPurchaseOrderInFacility`/
`assertPurchaseOrderLineInFacility`) **before** touching any balance or
ledger row. This closes a real gap found during this phase's own build (see
`docs/PHASE_6A_INTEGRITY.md`'s Bugs Found section): the route layer
correctly resolves the caller's own `facilityId` via `requireFacilityStaff`,
but nothing re-derived facility ownership from a client-suppliable
`itemId`/`locationId`/`lotId`/`supplierId` — without the service-layer
assertions, a caller correctly scoped to their own facility could still
pass another facility's resource ID and have it silently accepted. `Item`
with `facilityId: null` (a global catalog item) is allowed at any
facility; a facility-scoped item must match exactly.
