/*
  Warnings:

  - Made the column `idempotencyKey` on table `GoodsReceipt` required. This step will fail if there are existing NULL values in that column.
  - Made the column `idempotencyKey` on table `PurchaseOrder` required. This step will fail if there are existing NULL values in that column.
  - Made the column `idempotencyKey` on table `PurchaseRequisition` required. This step will fail if there are existing NULL values in that column.
  - Made the column `idempotencyKey` on table `StockAdjustment` required. This step will fail if there are existing NULL values in that column.
  - Made the column `idempotencyKey` on table `StockReservation` required. This step will fail if there are existing NULL values in that column.
  - Made the column `idempotencyKey` on table `StockTransfer` required. This step will fail if there are existing NULL values in that column.
  - Made the column `idempotencyKey` on table `WasteRecord` required. This step will fail if there are existing NULL values in that column.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_GoodsReceipt" (
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
    "idempotencyKey" TEXT NOT NULL,
    "notes" TEXT,
    CONSTRAINT "GoodsReceipt_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "GoodsReceipt_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_GoodsReceipt" ("approvedAt", "approvedByStaffId", "facilityId", "id", "idempotencyKey", "notes", "purchaseOrderId", "receiptNumber", "recordedAt", "recordedByStaffId", "rejectedAt", "rejectedByStaffId", "rejectionReason", "status") SELECT "approvedAt", "approvedByStaffId", "facilityId", "id", "idempotencyKey", "notes", "purchaseOrderId", "receiptNumber", "recordedAt", "recordedByStaffId", "rejectedAt", "rejectedByStaffId", "rejectionReason", "status" FROM "GoodsReceipt";
DROP TABLE "GoodsReceipt";
ALTER TABLE "new_GoodsReceipt" RENAME TO "GoodsReceipt";
CREATE UNIQUE INDEX "GoodsReceipt_receiptNumber_key" ON "GoodsReceipt"("receiptNumber");
CREATE UNIQUE INDEX "GoodsReceipt_idempotencyKey_key" ON "GoodsReceipt"("idempotencyKey");
CREATE INDEX "GoodsReceipt_purchaseOrderId_idx" ON "GoodsReceipt"("purchaseOrderId");
CREATE INDEX "GoodsReceipt_facilityId_status_idx" ON "GoodsReceipt"("facilityId", "status");
CREATE TABLE "new_PurchaseOrder" (
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
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PurchaseOrder_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PurchaseOrder_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PurchaseOrder_requisitionId_fkey" FOREIGN KEY ("requisitionId") REFERENCES "PurchaseRequisition" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_PurchaseOrder" ("approvedAt", "approvedByStaffId", "cancelledAt", "cancelledReason", "closedAt", "createdAt", "createdByStaffId", "currency", "expectedDeliveryDate", "facilityId", "id", "idempotencyKey", "orderNumber", "requisitionId", "sentAt", "status", "subtotalMinor", "supplierId", "taxMinor", "totalMinor") SELECT "approvedAt", "approvedByStaffId", "cancelledAt", "cancelledReason", "closedAt", "createdAt", "createdByStaffId", "currency", "expectedDeliveryDate", "facilityId", "id", "idempotencyKey", "orderNumber", "requisitionId", "sentAt", "status", "subtotalMinor", "supplierId", "taxMinor", "totalMinor" FROM "PurchaseOrder";
DROP TABLE "PurchaseOrder";
ALTER TABLE "new_PurchaseOrder" RENAME TO "PurchaseOrder";
CREATE UNIQUE INDEX "PurchaseOrder_orderNumber_key" ON "PurchaseOrder"("orderNumber");
CREATE UNIQUE INDEX "PurchaseOrder_idempotencyKey_key" ON "PurchaseOrder"("idempotencyKey");
CREATE INDEX "PurchaseOrder_facilityId_status_idx" ON "PurchaseOrder"("facilityId", "status");
CREATE TABLE "new_PurchaseRequisition" (
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
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PurchaseRequisition_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PurchaseRequisition_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_PurchaseRequisition" ("approvedAt", "approvedByStaffId", "cancelledAt", "cancelledReason", "createdAt", "departmentId", "facilityId", "id", "idempotencyKey", "justification", "priority", "rejectedAt", "rejectedByStaffId", "rejectionReason", "requestedByStaffId", "requiredByDate", "requisitionNumber", "status", "submittedAt", "supersedesRequisitionId") SELECT "approvedAt", "approvedByStaffId", "cancelledAt", "cancelledReason", "createdAt", "departmentId", "facilityId", "id", "idempotencyKey", "justification", "priority", "rejectedAt", "rejectedByStaffId", "rejectionReason", "requestedByStaffId", "requiredByDate", "requisitionNumber", "status", "submittedAt", "supersedesRequisitionId" FROM "PurchaseRequisition";
DROP TABLE "PurchaseRequisition";
ALTER TABLE "new_PurchaseRequisition" RENAME TO "PurchaseRequisition";
CREATE UNIQUE INDEX "PurchaseRequisition_requisitionNumber_key" ON "PurchaseRequisition"("requisitionNumber");
CREATE UNIQUE INDEX "PurchaseRequisition_idempotencyKey_key" ON "PurchaseRequisition"("idempotencyKey");
CREATE INDEX "PurchaseRequisition_facilityId_status_idx" ON "PurchaseRequisition"("facilityId", "status");
CREATE TABLE "new_StockAdjustment" (
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
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockAdjustment_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockAdjustment_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockAdjustment_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "ItemLot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockAdjustment_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_StockAdjustment" ("approvedAt", "approvedByStaffId", "createdAt", "facilityId", "id", "idempotencyKey", "itemId", "locationId", "lotId", "notes", "quantityDelta", "reason", "rejectedAt", "rejectionReason", "requestedByStaffId", "sourceId", "sourceType", "status") SELECT "approvedAt", "approvedByStaffId", "createdAt", "facilityId", "id", "idempotencyKey", "itemId", "locationId", "lotId", "notes", "quantityDelta", "reason", "rejectedAt", "rejectionReason", "requestedByStaffId", "sourceId", "sourceType", "status" FROM "StockAdjustment";
DROP TABLE "StockAdjustment";
ALTER TABLE "new_StockAdjustment" RENAME TO "StockAdjustment";
CREATE UNIQUE INDEX "StockAdjustment_idempotencyKey_key" ON "StockAdjustment"("idempotencyKey");
CREATE INDEX "StockAdjustment_facilityId_status_idx" ON "StockAdjustment"("facilityId", "status");
CREATE TABLE "new_StockReservation" (
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
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockReservation_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockReservation_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockReservation_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "ItemLot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockReservation_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_StockReservation" ("createdAt", "encounterId", "expiresAt", "facilityId", "id", "idempotencyKey", "itemId", "locationId", "lotId", "patientId", "quantity", "releasedAt", "releasedByUserId", "requestedByStaffId", "reservedForId", "reservedForType", "status") SELECT "createdAt", "encounterId", "expiresAt", "facilityId", "id", "idempotencyKey", "itemId", "locationId", "lotId", "patientId", "quantity", "releasedAt", "releasedByUserId", "requestedByStaffId", "reservedForId", "reservedForType", "status" FROM "StockReservation";
DROP TABLE "StockReservation";
ALTER TABLE "new_StockReservation" RENAME TO "StockReservation";
CREATE UNIQUE INDEX "StockReservation_idempotencyKey_key" ON "StockReservation"("idempotencyKey");
CREATE INDEX "StockReservation_facilityId_itemId_lotId_locationId_idx" ON "StockReservation"("facilityId", "itemId", "lotId", "locationId");
CREATE INDEX "StockReservation_status_idx" ON "StockReservation"("status");
CREATE TABLE "new_StockTransfer" (
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
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockTransfer_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockTransfer_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockTransfer_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "ItemLot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockTransfer_fromLocationId_fkey" FOREIGN KEY ("fromLocationId") REFERENCES "StockLocation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockTransfer_toLocationId_fkey" FOREIGN KEY ("toLocationId") REFERENCES "StockLocation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_StockTransfer" ("cancelledAt", "cancelledReason", "createdAt", "facilityId", "fromLocationId", "id", "idempotencyKey", "initiatedAt", "itemId", "lotId", "quantity", "reason", "receivedAt", "receivedByStaffId", "requestedByStaffId", "status", "toLocationId") SELECT "cancelledAt", "cancelledReason", "createdAt", "facilityId", "fromLocationId", "id", "idempotencyKey", "initiatedAt", "itemId", "lotId", "quantity", "reason", "receivedAt", "receivedByStaffId", "requestedByStaffId", "status", "toLocationId" FROM "StockTransfer";
DROP TABLE "StockTransfer";
ALTER TABLE "new_StockTransfer" RENAME TO "StockTransfer";
CREATE UNIQUE INDEX "StockTransfer_idempotencyKey_key" ON "StockTransfer"("idempotencyKey");
CREATE INDEX "StockTransfer_facilityId_status_idx" ON "StockTransfer"("facilityId", "status");
CREATE TABLE "new_WasteRecord" (
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
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WasteRecord_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "WasteRecord_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "WasteRecord_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "ItemLot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "WasteRecord_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_WasteRecord" ("approvedAt", "approvedByStaffId", "createdAt", "encounterId", "facilityId", "id", "idempotencyKey", "itemId", "locationId", "lotId", "notes", "patientId", "quantity", "reason", "requestedByStaffId", "status") SELECT "approvedAt", "approvedByStaffId", "createdAt", "encounterId", "facilityId", "id", "idempotencyKey", "itemId", "locationId", "lotId", "notes", "patientId", "quantity", "reason", "requestedByStaffId", "status" FROM "WasteRecord";
DROP TABLE "WasteRecord";
ALTER TABLE "new_WasteRecord" RENAME TO "WasteRecord";
CREATE UNIQUE INDEX "WasteRecord_idempotencyKey_key" ON "WasteRecord"("idempotencyKey");
CREATE INDEX "WasteRecord_facilityId_status_idx" ON "WasteRecord"("facilityId", "status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
