-- Phase 6A fix: requisitionNumber/orderNumber/receiptNumber were declared
-- globally @unique, but the underlying sequence counters
-- (PurchaseRequisitionSequence/PurchaseOrderSequence/GoodsReceiptSequence)
-- are keyed (facilityId, fiscalYear) and reset per facility — so two
-- facilities both issuing their first document of the year would both
-- format to e.g. "REQ-2026-000001" and collide on a global unique index.
-- Discovered live via the multi-facility seed script. Scoped to
-- (facilityId, <number>) instead, matching how the number is actually
-- generated.
-- DropIndex
DROP INDEX "GoodsReceipt_receiptNumber_key";

-- DropIndex
DROP INDEX "PurchaseOrder_orderNumber_key";

-- DropIndex
DROP INDEX "PurchaseRequisition_requisitionNumber_key";

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceipt_facilityId_receiptNumber_key" ON "GoodsReceipt"("facilityId", "receiptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_facilityId_orderNumber_key" ON "PurchaseOrder"("facilityId", "orderNumber");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseRequisition_facilityId_requisitionNumber_key" ON "PurchaseRequisition"("facilityId", "requisitionNumber");
