-- CreateTable
CREATE TABLE "Item" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL,
    "baseUnit" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "trackLots" BOOLEAN NOT NULL DEFAULT true,
    "trackExpiry" BOOLEAN NOT NULL DEFAULT true,
    "trackSerial" BOOLEAN NOT NULL DEFAULT false,
    "reorderMinLevel" REAL,
    "reorderMaxLevel" REAL,
    "reorderPoint" REAL,
    "reorderQuantity" REAL,
    "preferredSupplierId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Item_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Item_preferredSupplierId_fkey" FOREIGN KEY ("preferredSupplierId") REFERENCES "Supplier" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ItemUnitConversion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "itemId" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "baseUnitsPerUnit" REAL NOT NULL,
    CONSTRAINT "ItemUnitConversion_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MedicationItemLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT,
    "drugNameKey" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MedicationItemLink_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "MedicationItemLink_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StockLocation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "parentLocationId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockLocation_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockLocation_parentLocationId_fkey" FOREIGN KEY ("parentLocationId") REFERENCES "StockLocation" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ItemLot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "itemId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "lotNumber" TEXT NOT NULL,
    "manufacturer" TEXT,
    "manufacturedAt" DATETIME,
    "expiresAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "quarantineReason" TEXT,
    "quarantinedAt" DATETIME,
    "quarantinedByUserId" TEXT,
    "releasedAt" DATETIME,
    "releasedByUserId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ItemLot_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ItemLot_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StockLedgerEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "movementType" TEXT NOT NULL,
    "onHandDelta" REAL NOT NULL DEFAULT 0,
    "reservedDelta" REAL NOT NULL DEFAULT 0,
    "unit" TEXT NOT NULL,
    "wasteReason" TEXT,
    "adjustmentReason" TEXT,
    "reason" TEXT,
    "notes" TEXT,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "movementGroupId" TEXT,
    "patientId" TEXT,
    "encounterId" TEXT,
    "actorUserId" TEXT NOT NULL,
    "actorStaffId" TEXT,
    "postedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockLedgerEntry_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockLedgerEntry_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockLedgerEntry_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "ItemLot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockLedgerEntry_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StockBalance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "onHandQty" REAL NOT NULL DEFAULT 0,
    "reservedQty" REAL NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StockBalance_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockBalance_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockBalance_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "ItemLot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockBalance_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StockReservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "quantity" REAL NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "reservedForType" TEXT,
    "reservedForId" TEXT,
    "patientId" TEXT,
    "encounterId" TEXT,
    "requestedByStaffId" TEXT NOT NULL,
    "expiresAt" DATETIME,
    "releasedAt" DATETIME,
    "releasedByUserId" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockReservation_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockReservation_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockReservation_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "ItemLot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockReservation_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StockTransfer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "fromLocationId" TEXT NOT NULL,
    "toLocationId" TEXT NOT NULL,
    "quantity" REAL NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "reason" TEXT,
    "requestedByStaffId" TEXT NOT NULL,
    "initiatedAt" DATETIME,
    "receivedByStaffId" TEXT,
    "receivedAt" DATETIME,
    "cancelledAt" DATETIME,
    "cancelledReason" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockTransfer_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockTransfer_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockTransfer_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "ItemLot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockTransfer_fromLocationId_fkey" FOREIGN KEY ("fromLocationId") REFERENCES "StockLocation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockTransfer_toLocationId_fkey" FOREIGN KEY ("toLocationId") REFERENCES "StockLocation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StockAdjustment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "quantityDelta" REAL NOT NULL,
    "reason" TEXT NOT NULL,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'POSTED',
    "requestedByStaffId" TEXT NOT NULL,
    "approvedByStaffId" TEXT,
    "approvedAt" DATETIME,
    "rejectedAt" DATETIME,
    "rejectionReason" TEXT,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockAdjustment_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockAdjustment_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockAdjustment_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "ItemLot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockAdjustment_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WasteRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "quantity" REAL NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'POSTED',
    "patientId" TEXT,
    "encounterId" TEXT,
    "requestedByStaffId" TEXT NOT NULL,
    "approvedByStaffId" TEXT,
    "approvedAt" DATETIME,
    "notes" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WasteRecord_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "WasteRecord_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "WasteRecord_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "ItemLot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "WasteRecord_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StockTake" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "startedByStaffId" TEXT NOT NULL,
    "startedAt" DATETIME,
    "completedByStaffId" TEXT,
    "completedAt" DATETIME,
    "cancelledAt" DATETIME,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockTake_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockTake_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StockTakeLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "stockTakeId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "systemQuantity" REAL NOT NULL,
    "countedQuantity" REAL,
    "varianceQuantity" REAL,
    "resultingAdjustmentId" TEXT,
    CONSTRAINT "StockTakeLine_stockTakeId_fkey" FOREIGN KEY ("stockTakeId") REFERENCES "StockTake" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockTakeLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockTakeLine_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "ItemLot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockTakeLine_resultingAdjustmentId_fkey" FOREIGN KEY ("resultingAdjustmentId") REFERENCES "StockAdjustment" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "contactName" TEXT,
    "contactPhone" TEXT,
    "contactEmail" TEXT,
    "address" TEXT,
    "paymentTermsDays" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Supplier_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PurchaseRequisitionSequence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "fiscalYear" INTEGER NOT NULL,
    "nextValue" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "PurchaseRequisitionSequence_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PurchaseRequisition" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requisitionNumber" TEXT,
    "facilityId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "requestedByStaffId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "priority" TEXT NOT NULL DEFAULT 'ROUTINE',
    "justification" TEXT NOT NULL,
    "requiredByDate" DATETIME,
    "supersedesRequisitionId" TEXT,
    "submittedAt" DATETIME,
    "approvedAt" DATETIME,
    "approvedByStaffId" TEXT,
    "rejectedAt" DATETIME,
    "rejectedByStaffId" TEXT,
    "rejectionReason" TEXT,
    "cancelledAt" DATETIME,
    "cancelledReason" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PurchaseRequisition_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PurchaseRequisition_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PurchaseRequisitionLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requisitionId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" REAL NOT NULL,
    "unit" TEXT NOT NULL,
    "approvedQuantity" REAL,
    "notes" TEXT,
    CONSTRAINT "PurchaseRequisitionLine_requisitionId_fkey" FOREIGN KEY ("requisitionId") REFERENCES "PurchaseRequisition" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PurchaseRequisitionLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PurchaseOrderSequence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "fiscalYear" INTEGER NOT NULL,
    "nextValue" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "PurchaseOrderSequence_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderNumber" TEXT,
    "facilityId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "requisitionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "subtotalMinor" INTEGER NOT NULL DEFAULT 0,
    "taxMinor" INTEGER NOT NULL DEFAULT 0,
    "totalMinor" INTEGER NOT NULL DEFAULT 0,
    "expectedDeliveryDate" DATETIME,
    "createdByStaffId" TEXT NOT NULL,
    "approvedByStaffId" TEXT,
    "approvedAt" DATETIME,
    "sentAt" DATETIME,
    "cancelledAt" DATETIME,
    "cancelledReason" TEXT,
    "closedAt" DATETIME,
    "idempotencyKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PurchaseOrder_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PurchaseOrder_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PurchaseOrder_requisitionId_fkey" FOREIGN KEY ("requisitionId") REFERENCES "PurchaseRequisition" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PurchaseOrderLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "purchaseOrderId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "orderedQuantity" REAL NOT NULL,
    "unit" TEXT NOT NULL,
    "unitPriceMinor" INTEGER NOT NULL,
    "taxPercent" REAL NOT NULL DEFAULT 0,
    "lineTotalMinor" INTEGER NOT NULL,
    "receivedQuantity" REAL NOT NULL DEFAULT 0,
    CONSTRAINT "PurchaseOrderLine_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PurchaseOrderLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GoodsReceiptSequence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "fiscalYear" INTEGER NOT NULL,
    "nextValue" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "GoodsReceiptSequence_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GoodsReceipt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "receiptNumber" TEXT,
    "purchaseOrderId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECORDED',
    "recordedByStaffId" TEXT NOT NULL,
    "recordedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedByStaffId" TEXT,
    "approvedAt" DATETIME,
    "rejectedByStaffId" TEXT,
    "rejectedAt" DATETIME,
    "rejectionReason" TEXT,
    "idempotencyKey" TEXT,
    "notes" TEXT,
    CONSTRAINT "GoodsReceipt_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "GoodsReceipt_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GoodsReceiptLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "goodsReceiptId" TEXT NOT NULL,
    "purchaseOrderLineId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "lotNumber" TEXT NOT NULL,
    "manufacturer" TEXT,
    "manufacturedAt" DATETIME,
    "expiresAt" DATETIME,
    "acceptedQuantity" REAL NOT NULL,
    "rejectedQuantity" REAL NOT NULL DEFAULT 0,
    "rejectionReason" TEXT,
    "locationId" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    CONSTRAINT "GoodsReceiptLine_goodsReceiptId_fkey" FOREIGN KEY ("goodsReceiptId") REFERENCES "GoodsReceipt" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "GoodsReceiptLine_purchaseOrderLineId_fkey" FOREIGN KEY ("purchaseOrderLineId") REFERENCES "PurchaseOrderLine" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "GoodsReceiptLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "GoodsReceiptLine_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Item_sku_key" ON "Item"("sku");

-- CreateIndex
CREATE INDEX "Item_facilityId_idx" ON "Item"("facilityId");

-- CreateIndex
CREATE INDEX "Item_category_idx" ON "Item"("category");

-- CreateIndex
CREATE UNIQUE INDEX "ItemUnitConversion_itemId_unit_key" ON "ItemUnitConversion"("itemId", "unit");

-- CreateIndex
CREATE UNIQUE INDEX "MedicationItemLink_facilityId_drugNameKey_key" ON "MedicationItemLink"("facilityId", "drugNameKey");

-- CreateIndex
CREATE INDEX "StockLocation_facilityId_active_idx" ON "StockLocation"("facilityId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "StockLocation_facilityId_name_key" ON "StockLocation"("facilityId", "name");

-- CreateIndex
CREATE INDEX "ItemLot_facilityId_status_idx" ON "ItemLot"("facilityId", "status");

-- CreateIndex
CREATE INDEX "ItemLot_expiresAt_idx" ON "ItemLot"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ItemLot_itemId_facilityId_lotNumber_key" ON "ItemLot"("itemId", "facilityId", "lotNumber");

-- CreateIndex
CREATE INDEX "StockLedgerEntry_facilityId_itemId_lotId_locationId_idx" ON "StockLedgerEntry"("facilityId", "itemId", "lotId", "locationId");

-- CreateIndex
CREATE INDEX "StockLedgerEntry_facilityId_movementType_postedAt_idx" ON "StockLedgerEntry"("facilityId", "movementType", "postedAt");

-- CreateIndex
CREATE INDEX "StockLedgerEntry_facilityId_postedAt_idx" ON "StockLedgerEntry"("facilityId", "postedAt");

-- CreateIndex
CREATE INDEX "StockLedgerEntry_patientId_idx" ON "StockLedgerEntry"("patientId");

-- CreateIndex
CREATE INDEX "StockLedgerEntry_encounterId_idx" ON "StockLedgerEntry"("encounterId");

-- CreateIndex
CREATE INDEX "StockLedgerEntry_sourceType_sourceId_idx" ON "StockLedgerEntry"("sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "StockLedgerEntry_sourceType_sourceId_movementType_key" ON "StockLedgerEntry"("sourceType", "sourceId", "movementType");

-- CreateIndex
CREATE INDEX "StockBalance_facilityId_itemId_idx" ON "StockBalance"("facilityId", "itemId");

-- CreateIndex
CREATE INDEX "StockBalance_facilityId_locationId_idx" ON "StockBalance"("facilityId", "locationId");

-- CreateIndex
CREATE UNIQUE INDEX "StockBalance_itemId_lotId_locationId_key" ON "StockBalance"("itemId", "lotId", "locationId");

-- CreateIndex
CREATE UNIQUE INDEX "StockReservation_idempotencyKey_key" ON "StockReservation"("idempotencyKey");

-- CreateIndex
CREATE INDEX "StockReservation_facilityId_itemId_lotId_locationId_idx" ON "StockReservation"("facilityId", "itemId", "lotId", "locationId");

-- CreateIndex
CREATE INDEX "StockReservation_status_idx" ON "StockReservation"("status");

-- CreateIndex
CREATE UNIQUE INDEX "StockTransfer_idempotencyKey_key" ON "StockTransfer"("idempotencyKey");

-- CreateIndex
CREATE INDEX "StockTransfer_facilityId_status_idx" ON "StockTransfer"("facilityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "StockAdjustment_idempotencyKey_key" ON "StockAdjustment"("idempotencyKey");

-- CreateIndex
CREATE INDEX "StockAdjustment_facilityId_status_idx" ON "StockAdjustment"("facilityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WasteRecord_idempotencyKey_key" ON "WasteRecord"("idempotencyKey");

-- CreateIndex
CREATE INDEX "WasteRecord_facilityId_status_idx" ON "WasteRecord"("facilityId", "status");

-- CreateIndex
CREATE INDEX "StockTake_facilityId_locationId_status_idx" ON "StockTake"("facilityId", "locationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "StockTakeLine_resultingAdjustmentId_key" ON "StockTakeLine"("resultingAdjustmentId");

-- CreateIndex
CREATE UNIQUE INDEX "StockTakeLine_stockTakeId_itemId_lotId_key" ON "StockTakeLine"("stockTakeId", "itemId", "lotId");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_facilityId_code_key" ON "Supplier"("facilityId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseRequisitionSequence_facilityId_fiscalYear_key" ON "PurchaseRequisitionSequence"("facilityId", "fiscalYear");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseRequisition_requisitionNumber_key" ON "PurchaseRequisition"("requisitionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseRequisition_idempotencyKey_key" ON "PurchaseRequisition"("idempotencyKey");

-- CreateIndex
CREATE INDEX "PurchaseRequisition_facilityId_status_idx" ON "PurchaseRequisition"("facilityId", "status");

-- CreateIndex
CREATE INDEX "PurchaseRequisitionLine_requisitionId_idx" ON "PurchaseRequisitionLine"("requisitionId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrderSequence_facilityId_fiscalYear_key" ON "PurchaseOrderSequence"("facilityId", "fiscalYear");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_orderNumber_key" ON "PurchaseOrder"("orderNumber");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_idempotencyKey_key" ON "PurchaseOrder"("idempotencyKey");

-- CreateIndex
CREATE INDEX "PurchaseOrder_facilityId_status_idx" ON "PurchaseOrder"("facilityId", "status");

-- CreateIndex
CREATE INDEX "PurchaseOrderLine_purchaseOrderId_idx" ON "PurchaseOrderLine"("purchaseOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceiptSequence_facilityId_fiscalYear_key" ON "GoodsReceiptSequence"("facilityId", "fiscalYear");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceipt_receiptNumber_key" ON "GoodsReceipt"("receiptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceipt_idempotencyKey_key" ON "GoodsReceipt"("idempotencyKey");

-- CreateIndex
CREATE INDEX "GoodsReceipt_purchaseOrderId_idx" ON "GoodsReceipt"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "GoodsReceipt_facilityId_status_idx" ON "GoodsReceipt"("facilityId", "status");

-- CreateIndex
CREATE INDEX "GoodsReceiptLine_purchaseOrderLineId_idx" ON "GoodsReceiptLine"("purchaseOrderLineId");

-- CreateIndex
CREATE INDEX "GoodsReceiptLine_goodsReceiptId_idx" ON "GoodsReceiptLine"("goodsReceiptId");

-- Phase 6A hardening: at most one IN_PROGRESS stocktake per location.
-- Two concurrent counts of the same location would both snapshot
-- systemQuantity against a moving target and could double-adjust. This is
-- an "at most one active" invariant, not an interval-overlap, so a plain
-- partial unique index (portable across SQLite and Postgres) is correct
-- and simpler than a GiST exclusion constraint.
CREATE UNIQUE INDEX "stocktake_one_in_progress_per_location"
  ON "StockTake" ("facilityId", "locationId") WHERE status = 'IN_PROGRESS';
