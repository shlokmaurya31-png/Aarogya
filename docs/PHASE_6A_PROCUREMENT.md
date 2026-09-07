# Phase 6A — Procurement

## Supplier

`Supplier` (`facilityId`, `name`, `code` — `@@unique([facilityId, code])`,
business contact fields only (`contactName/contactPhone/contactEmail/
address`), `paymentTermsDays?`, `active`). No unnecessary personal
information is stored — this is a business-entity record, not a person
record.

## Purchase Requisition

`PurchaseRequisition` lifecycle: `DRAFT → SUBMITTED → APPROVED |
REJECTED | CANCELLED`. `requisitionNumber` is assigned atomically at
`SUBMIT` via `procurement/sequence.ts#nextPurchaseRequisitionSequence`
(a per-facility-per-fiscal-year counter, copying `billing/sequence.ts
#nextSequence`'s exact guarded-CAS idiom against its own dedicated
`PurchaseRequisitionSequence` table — the established convention in this
codebase is to duplicate this small idiom per numbered-document type
rather than generalize the shared `InvoiceSequence` table/key shape).
`PurchaseRequisitionLine.approvedQuantity` is set equal to the requested
quantity at approval time and is immutable from then on (service-level
guard — no route ever accepts a client-supplied edit to it after
approval). A "revision" of an approved requisition is cancel + clone into
a new `DRAFT` (`reviseApprovedRequisition`, `supersedesRequisitionId`
linkage) — never an in-place edit of an already-approved document.

## Purchase Order

`PurchaseOrder` lifecycle: `DRAFT → PENDING_APPROVAL → APPROVED → SENT →
PARTIALLY_RECEIVED → RECEIVED → CANCELLED → CLOSED`. `orderNumber` is
assigned atomically at `submitForApproval` via the same per-facility
sequence idiom. `subtotalMinor`/`taxMinor`/`totalMinor` are always
server-computed (`procurement/pricing.ts`, reusing `billing/money.ts`'s
`roundHalfUp`/`sumMinor` — one rounding policy, never reimplemented) —
never trusted from the client. `PurchaseOrderLine.receivedQuantity` is a
ceiling-guarded running total (see Integrity doc for the exact mechanism),
never a value the client can set directly. `PARTIALLY_RECEIVED`/`RECEIVED`
are derived purely from the lines' own `receivedQuantity` vs
`orderedQuantity` (`recomputeReceivingStatus`, called after every goods-
receipt approval) — never a separately-set flag that could drift from
reality.

## Goods Receipt

Workflow: `PO → GoodsReceipt (RECORDED, no stock effect) → approve
(APPROVED, stock posted) | reject (REJECTED)`. Recording and approving are
deliberately separate steps — a receipt can be entered by one person and
approved by another (see Maker/Checker below), and the stock effect is
gated behind that approval, not the initial data entry.

**Partial receipt is fully supported** — a `GoodsReceipt` covers a subset
of a PO's lines/quantities; multiple receipts against the same PO
(different delivery dates) are normal and expected. **Over-receipt is
rejected by default**: a ceiling-guarded atomic UPDATE on
`receivedQuantity` (`WHERE orderedQuantity - receivedQuantity >=
acceptedQuantity`) refuses to let the sum of accepted quantities across
all receipts for a line exceed what was ordered — see
`docs/PHASE_6A_INTEGRITY.md` for why this single mechanism also closes
the duplicate-receipt concurrency race.

**Rejected quantity is captured, not discarded.** Each `GoodsReceiptLine`
carries `acceptedQuantity` and `rejectedQuantity` independently, with an
optional `rejectionReason`. Only `acceptedQuantity` is ever posted to the
stock ledger/balance — rejected units never enter usable stock, but the
fact that they arrived and were rejected (and why) is permanently
recorded on the line, never silently dropped.

`idempotencyKey` on the `GoodsReceipt` header is the natural key for "this
receiving submission" — deliberately **not** `purchaseOrderLineId` alone,
which would incorrectly forbid legitimate multiple partial deliveries
against the same line over time. A retried identical submission (same
key) returns the already-existing header and creates no duplicate lines.

Lot creation happens at approval time: `getOrCreateLot` is keyed on the
real `@@unique([itemId, facilityId, lotNumber])` constraint via the same
raw `INSERT ... ON CONFLICT DO NOTHING` idiom used throughout this phase,
so two receipts recording the same physical batch number never create two
lot rows.

## Stock Transfers

Location-to-location, same facility only this phase (no cross-facility
transfer). Stock leaves the source location the moment a transfer is
*initiated* (`TRANSFER_OUT` posted immediately, atomic-conditional-
decrement-guarded — a transfer consumes source-location availability
exactly like an issue does), not deferred until receipt. `receiveTransfer`
is a guarded status CAS (`IN_TRANSIT → RECEIVED`) — the standard `bed.ts`/
`appointment.ts` idiom, since this is a pure enum-status race, not a
quantity race. `cancelTransfer` returns stock to the source via a
compensating `RETURN` ledger entry — the original `TRANSFER_OUT` row is
never rewritten.

## Stock Adjustments

Reasons: `COUNT_CORRECTION | DAMAGE | LOSS | FOUND | DATA_CORRECTION |
OTHER`. Normal-impact adjustments (`|quantityDelta| <
HIGH_IMPACT_ADJUSTMENT_QTY_THRESHOLD`, currently 50) post immediately.
High-impact adjustments are recorded `PENDING_APPROVAL` with **no stock
effect** until a *different* staff member approves
(`SameActorApprovalError` if the approver matches the requester) — the
exact maker/checker mechanism `billing/refunds.ts` already established in
Phase 5. No arbitrary quantity change is ever accepted without going
through this reason-coded, (conditionally) approval-gated path.

## Stocktake / Cycle Count

`StockTake` (`DRAFT → IN_PROGRESS → COMPLETED | CANCELLED`) is guarded by
a **partial unique index** — `stocktake_one_in_progress_per_location` on
`(facilityId, locationId) WHERE status = 'IN_PROGRESS'` — so two
concurrent counts of the same location can't both proceed. `StockTakeLine
.systemQuantity` is snapshotted the moment a line is added, never
re-read live at completion, so a variance always reflects "what the
system said when this line was counted," not a moving target the counter
never actually saw. Completing a stocktake **never silently overwrites**
the system quantity with the counted quantity — it creates one
`StockAdjustment` per non-zero-variance line (reason `COUNT_CORRECTION`),
which itself flows through the same normal/high-impact approval threshold
as any other adjustment. The resulting adjustment's id is linked back
onto the line (`resultingAdjustmentId`), so the audit trail from "counted
15, system said 20" to "adjustment −5, approved by X" is fully traceable.

## Waste

`WasteRecord` (reasons: `EXPIRED | DAMAGED | CONTAMINATED |
OPENED_UNUSED | ACCIDENTAL_LOSS`) is its own ledger movement type, never
an invisible quantity decrement folded into something else. Normal-value
waste (`quantity < HIGH_VALUE_WASTE_QTY_THRESHOLD`, currently 50) posts
immediately; high-value waste requires a different-actor approval, same
mechanism as high-impact adjustments. No item cost/valuation model exists
this phase (see Scope Cuts below), so "high-value" is approximated by
quantity — a documented simplification, not a silently different
definition of "value" than what the brief implied.

## Recall / Quarantine

A lot can become `QUARANTINED` (`inventory/lots.ts#quarantineLot`,
guarded CAS with a required reason) and `releaseLotFromQuarantine`
reverses it. Ordinary issue is unconditionally blocked from a quarantined
lot (`fefo.ts#validateExplicitLot`, checked even when a lot is explicitly
selected, bypassing FEFO) — this is the mechanism for medication recalls,
defective consumables, and contaminated batches. No external recall
integration exists or was attempted.

## Reorder Policy

`Item.reorderMinLevel/reorderMaxLevel/reorderPoint/reorderQuantity` are
plain configuration fields. `inventory/reorder.ts#computeReorderState` is
a pure function (unit-tested, 3 cases) that only *flags* items at or below
their reorder point — no automatic purchasing, no auto-generated
requisition or PO. `GET /api/hospital/inventory/stock/low-stock` (and the
identical `reports/reorder` route) surfaces the signal, paginated,
nothing more.

## RBAC — new permissions, no new Role

New permission strings (`domain:resource:action`, matching this
codebase's existing convention): `inventory:item:view/manage`,
`inventory:location:manage`, `inventory:stock:view/receive/issue/reserve/
transfer/adjust/waste`, `inventory:lot:quarantine`,
`inventory:stocktake:manage`, `inventory:report:view`,
`procurement:supplier:view/manage`, `procurement:requisition:create/
approve`, `procurement:po:view/create/approve/cancel`,
`procurement:goodsReceipt:create/approve`.

- **PHARMACIST** — stock view/issue/reserve/transfer, lot quarantine,
  `goodsReceipt:create` (pharmacy-category receiving), supplier view,
  report view. The one fully wired-up inventory consumer this phase.
- **NURSE / LAB_TECHNICIAN / RADIOLOGY_TECH** — narrow view/issue/waste
  for their own department's consumption boundary (no dedicated UI yet —
  the service-layer `issueStock`/`consumeInventory` function is ready for
  Lab/Radiology to call once they have one), plus `requisition:create` to
  request their own department's stock.
- **DOCTOR** — `item:view` only, per the brief's explicit instruction.
- **HOSPITAL_ADMIN** — the full checker/store-manager/procurement tier:
  item/location manage, stock receive/transfer/adjust/waste, lot
  quarantine, stocktake, supplier manage, requisition approve, PO
  view/create/approve/cancel, goods-receipt create+approve.
- **BILLING_STAFF** — supplier/PO view + report view only (finance
  visibility, no operational permission), per the brief's explicit "finance
  sees purchase price where appropriate."
- **AAROGYA_ADMIN** — view-only oversight, matching its existing narrow
  billing footprint from Phase 5.

**Flagged limitation, not hidden**: the closed 13-role set (`Role` enum)
has no dedicated "Procurement Officer" role distinct from general facility
administration. `procurement:po:create`/`:approve`, non-pharmacy
`goodsReceipt:create`, and `requisition:approve` therefore all sit on
`HOSPITAL_ADMIN` alone. Separation of duties for these specific actions is
enforced at the **service layer** instead of the role layer — a same-actor
guard (`if (approvedByStaffId === createdByStaffId) throw new
SameActorApprovalError()`) on every approval function, mirroring
`billing/refunds.ts`'s exact mechanism. This is a deliberate choice
consistent with the brief's explicit "don't create a new Role unless
genuinely necessary" instruction, not an oversight — introducing a
dedicated role is listed as a candidate for a future phase in the
Integrity doc's remaining-risks section.

## Money

Purchase pricing follows the exact same principles established in Phase 5:
integer minor units (paise), explicit `currency` field
(`PurchaseOrder.currency`, `@default("INR")`), one centralized rounding
policy, server-side totals always. `procurement/pricing.ts` calls
`billing/money.ts`'s `roundHalfUp`/`sumMinor` directly — no second money
implementation was created.

## Scope cuts (explicit, not silently short-changed)

- No in-place PO/requisition revision after leaving `DRAFT` — cancel +
  reissue (optionally linked via `requisitionId`/`supersedesRequisitionId`)
  is the only correction path once a document has financial/procurement
  significance.
- No item cost/valuation/FIFO-costing model — `PurchaseOrderLine
  .unitPriceMinor` prices procurement only; there is no "current cost" or
  inventory valuation anywhere.
- No automatic purchasing triggered by reorder signals.
- No live supplier/ERP/payment-gateway integration.
- No dedicated Lab/Radiology consumption UI (the `issueStock` boundary is
  fully functional and ready for them to call).
