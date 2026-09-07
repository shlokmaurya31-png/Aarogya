-- CreateEnum
CREATE TYPE "ItemCategory" AS ENUM ('MEDICATION', 'CONSUMABLE', 'SURGICAL_SUPPLY', 'LAB_REAGENT', 'RADIOLOGY_CONSUMABLE', 'IMPLANT', 'EQUIPMENT', 'BLOOD_PRODUCT', 'OTHER');

-- CreateEnum
CREATE TYPE "UnitOfMeasure" AS ENUM ('TABLET', 'CAPSULE', 'VIAL', 'AMPOULE', 'BOTTLE', 'BOX', 'PACK', 'PIECE', 'ML', 'MG', 'GRAM', 'KG', 'LITER', 'OTHER');

-- CreateEnum
CREATE TYPE "LocationType" AS ENUM ('WAREHOUSE', 'STORE', 'PHARMACY', 'OT_STORE', 'LAB_STORE', 'RADIOLOGY_STORE', 'WARD_STORE', 'BIN', 'OTHER');

-- CreateEnum
CREATE TYPE "LotStatus" AS ENUM ('ACTIVE', 'QUARANTINED', 'EXPIRED', 'RECALLED', 'DEPLETED');

-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('RECEIPT', 'ISSUE', 'TRANSFER_OUT', 'TRANSFER_IN', 'RETURN', 'WASTE', 'ADJUSTMENT', 'RESERVATION', 'RELEASE');

-- CreateEnum
CREATE TYPE "StockReservationStatus" AS ENUM ('ACTIVE', 'RELEASED', 'CONSUMED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "StockTransferStatus" AS ENUM ('DRAFT', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StockAdjustmentStatus" AS ENUM ('POSTED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AdjustmentReason" AS ENUM ('COUNT_CORRECTION', 'DAMAGE', 'LOSS', 'FOUND', 'DATA_CORRECTION', 'OTHER');

-- CreateEnum
CREATE TYPE "WasteRecordStatus" AS ENUM ('POSTED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "WasteReason" AS ENUM ('EXPIRED', 'DAMAGED', 'CONTAMINATED', 'OPENED_UNUSED', 'ACCIDENTAL_LOSS');

-- CreateEnum
CREATE TYPE "StockTakeStatus" AS ENUM ('DRAFT', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RequisitionStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RequisitionPriority" AS ENUM ('ROUTINE', 'URGENT', 'EMERGENCY');

-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED', 'CLOSED');

-- CreateEnum
CREATE TYPE "GoodsReceiptStatus" AS ENUM ('RECORDED', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "Item" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" "ItemCategory" NOT NULL,
    "baseUnit" "UnitOfMeasure" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "trackLots" BOOLEAN NOT NULL DEFAULT true,
    "trackExpiry" BOOLEAN NOT NULL DEFAULT true,
    "trackSerial" BOOLEAN NOT NULL DEFAULT false,
    "reorderMinLevel" DOUBLE PRECISION,
    "reorderMaxLevel" DOUBLE PRECISION,
    "reorderPoint" DOUBLE PRECISION,
    "reorderQuantity" DOUBLE PRECISION,
    "preferredSupplierId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemUnitConversion" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "unit" "UnitOfMeasure" NOT NULL,
    "baseUnitsPerUnit" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "ItemUnitConversion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MedicationItemLink" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT,
    "drugNameKey" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MedicationItemLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockLocation" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "LocationType" NOT NULL,
    "parentLocationId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemLot" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "lotNumber" TEXT NOT NULL,
    "manufacturer" TEXT,
    "manufacturedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "status" "LotStatus" NOT NULL DEFAULT 'ACTIVE',
    "quarantineReason" TEXT,
    "quarantinedAt" TIMESTAMP(3),
    "quarantinedByUserId" TEXT,
    "releasedAt" TIMESTAMP(3),
    "releasedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ItemLot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockLedgerEntry" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "movementType" "StockMovementType" NOT NULL,
    "onHandDelta" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reservedDelta" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unit" "UnitOfMeasure" NOT NULL,
    "wasteReason" "WasteReason",
    "adjustmentReason" "AdjustmentReason",
    "reason" TEXT,
    "notes" TEXT,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "movementGroupId" TEXT,
    "patientId" TEXT,
    "encounterId" TEXT,
    "actorUserId" TEXT NOT NULL,
    "actorStaffId" TEXT,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockBalance" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "onHandQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reservedQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockBalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockReservation" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "status" "StockReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "reservedForType" TEXT,
    "reservedForId" TEXT,
    "patientId" TEXT,
    "encounterId" TEXT,
    "requestedByStaffId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "releasedByUserId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockTransfer" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "fromLocationId" TEXT NOT NULL,
    "toLocationId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "status" "StockTransferStatus" NOT NULL DEFAULT 'DRAFT',
    "reason" TEXT,
    "requestedByStaffId" TEXT NOT NULL,
    "initiatedAt" TIMESTAMP(3),
    "receivedByStaffId" TEXT,
    "receivedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledReason" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockAdjustment" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "quantityDelta" DOUBLE PRECISION NOT NULL,
    "reason" "AdjustmentReason" NOT NULL,
    "notes" TEXT,
    "status" "StockAdjustmentStatus" NOT NULL DEFAULT 'POSTED',
    "requestedByStaffId" TEXT NOT NULL,
    "approvedByStaffId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WasteRecord" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "reason" "WasteReason" NOT NULL,
    "status" "WasteRecordStatus" NOT NULL DEFAULT 'POSTED',
    "patientId" TEXT,
    "encounterId" TEXT,
    "requestedByStaffId" TEXT NOT NULL,
    "approvedByStaffId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "notes" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WasteRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockTake" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "status" "StockTakeStatus" NOT NULL DEFAULT 'DRAFT',
    "startedByStaffId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedByStaffId" TEXT,
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockTake_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockTakeLine" (
    "id" TEXT NOT NULL,
    "stockTakeId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "systemQuantity" DOUBLE PRECISION NOT NULL,
    "countedQuantity" DOUBLE PRECISION,
    "varianceQuantity" DOUBLE PRECISION,
    "resultingAdjustmentId" TEXT,

    CONSTRAINT "StockTakeLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "contactName" TEXT,
    "contactPhone" TEXT,
    "contactEmail" TEXT,
    "address" TEXT,
    "paymentTermsDays" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseRequisitionSequence" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "fiscalYear" INTEGER NOT NULL,
    "nextValue" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "PurchaseRequisitionSequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseRequisition" (
    "id" TEXT NOT NULL,
    "requisitionNumber" TEXT,
    "facilityId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "requestedByStaffId" TEXT NOT NULL,
    "status" "RequisitionStatus" NOT NULL DEFAULT 'DRAFT',
    "priority" "RequisitionPriority" NOT NULL DEFAULT 'ROUTINE',
    "justification" TEXT NOT NULL,
    "requiredByDate" TIMESTAMP(3),
    "supersedesRequisitionId" TEXT,
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "approvedByStaffId" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectedByStaffId" TEXT,
    "rejectionReason" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledReason" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseRequisition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseRequisitionLine" (
    "id" TEXT NOT NULL,
    "requisitionId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" "UnitOfMeasure" NOT NULL,
    "approvedQuantity" DOUBLE PRECISION,
    "notes" TEXT,

    CONSTRAINT "PurchaseRequisitionLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderSequence" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "fiscalYear" INTEGER NOT NULL,
    "nextValue" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "PurchaseOrderSequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL,
    "orderNumber" TEXT,
    "facilityId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "requisitionId" TEXT,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "subtotalMinor" INTEGER NOT NULL DEFAULT 0,
    "taxMinor" INTEGER NOT NULL DEFAULT 0,
    "totalMinor" INTEGER NOT NULL DEFAULT 0,
    "expectedDeliveryDate" TIMESTAMP(3),
    "createdByStaffId" TEXT NOT NULL,
    "approvedByStaffId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledReason" TEXT,
    "closedAt" TIMESTAMP(3),
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderLine" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "orderedQuantity" DOUBLE PRECISION NOT NULL,
    "unit" "UnitOfMeasure" NOT NULL,
    "unitPriceMinor" INTEGER NOT NULL,
    "taxPercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lineTotalMinor" INTEGER NOT NULL,
    "receivedQuantity" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "PurchaseOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoodsReceiptSequence" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "fiscalYear" INTEGER NOT NULL,
    "nextValue" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "GoodsReceiptSequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoodsReceipt" (
    "id" TEXT NOT NULL,
    "receiptNumber" TEXT,
    "purchaseOrderId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "status" "GoodsReceiptStatus" NOT NULL DEFAULT 'RECORDED',
    "recordedByStaffId" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedByStaffId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedByStaffId" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "notes" TEXT,

    CONSTRAINT "GoodsReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoodsReceiptLine" (
    "id" TEXT NOT NULL,
    "goodsReceiptId" TEXT NOT NULL,
    "purchaseOrderLineId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "lotNumber" TEXT NOT NULL,
    "manufacturer" TEXT,
    "manufacturedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "acceptedQuantity" DOUBLE PRECISION NOT NULL,
    "rejectedQuantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "rejectionReason" TEXT,
    "locationId" TEXT NOT NULL,
    "unit" "UnitOfMeasure" NOT NULL,

    CONSTRAINT "GoodsReceiptLine_pkey" PRIMARY KEY ("id")
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
CREATE UNIQUE INDEX "PurchaseRequisition_idempotencyKey_key" ON "PurchaseRequisition"("idempotencyKey");

-- CreateIndex
CREATE INDEX "PurchaseRequisition_facilityId_status_idx" ON "PurchaseRequisition"("facilityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseRequisition_facilityId_requisitionNumber_key" ON "PurchaseRequisition"("facilityId", "requisitionNumber");

-- CreateIndex
CREATE INDEX "PurchaseRequisitionLine_requisitionId_idx" ON "PurchaseRequisitionLine"("requisitionId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrderSequence_facilityId_fiscalYear_key" ON "PurchaseOrderSequence"("facilityId", "fiscalYear");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_idempotencyKey_key" ON "PurchaseOrder"("idempotencyKey");

-- CreateIndex
CREATE INDEX "PurchaseOrder_facilityId_status_idx" ON "PurchaseOrder"("facilityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_facilityId_orderNumber_key" ON "PurchaseOrder"("facilityId", "orderNumber");

-- CreateIndex
CREATE INDEX "PurchaseOrderLine_purchaseOrderId_idx" ON "PurchaseOrderLine"("purchaseOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceiptSequence_facilityId_fiscalYear_key" ON "GoodsReceiptSequence"("facilityId", "fiscalYear");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceipt_idempotencyKey_key" ON "GoodsReceipt"("idempotencyKey");

-- CreateIndex
CREATE INDEX "GoodsReceipt_purchaseOrderId_idx" ON "GoodsReceipt"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "GoodsReceipt_facilityId_status_idx" ON "GoodsReceipt"("facilityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceipt_facilityId_receiptNumber_key" ON "GoodsReceipt"("facilityId", "receiptNumber");

-- CreateIndex
CREATE INDEX "GoodsReceiptLine_purchaseOrderLineId_idx" ON "GoodsReceiptLine"("purchaseOrderLineId");

-- CreateIndex
CREATE INDEX "GoodsReceiptLine_goodsReceiptId_idx" ON "GoodsReceiptLine"("goodsReceiptId");

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_preferredSupplierId_fkey" FOREIGN KEY ("preferredSupplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemUnitConversion" ADD CONSTRAINT "ItemUnitConversion_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MedicationItemLink" ADD CONSTRAINT "MedicationItemLink_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MedicationItemLink" ADD CONSTRAINT "MedicationItemLink_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLocation" ADD CONSTRAINT "StockLocation_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLocation" ADD CONSTRAINT "StockLocation_parentLocationId_fkey" FOREIGN KEY ("parentLocationId") REFERENCES "StockLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemLot" ADD CONSTRAINT "ItemLot_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemLot" ADD CONSTRAINT "ItemLot_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLedgerEntry" ADD CONSTRAINT "StockLedgerEntry_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLedgerEntry" ADD CONSTRAINT "StockLedgerEntry_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLedgerEntry" ADD CONSTRAINT "StockLedgerEntry_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "ItemLot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLedgerEntry" ADD CONSTRAINT "StockLedgerEntry_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBalance" ADD CONSTRAINT "StockBalance_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBalance" ADD CONSTRAINT "StockBalance_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBalance" ADD CONSTRAINT "StockBalance_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "ItemLot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBalance" ADD CONSTRAINT "StockBalance_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "ItemLot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "ItemLot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_fromLocationId_fkey" FOREIGN KEY ("fromLocationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_toLocationId_fkey" FOREIGN KEY ("toLocationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockAdjustment" ADD CONSTRAINT "StockAdjustment_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockAdjustment" ADD CONSTRAINT "StockAdjustment_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockAdjustment" ADD CONSTRAINT "StockAdjustment_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "ItemLot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockAdjustment" ADD CONSTRAINT "StockAdjustment_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WasteRecord" ADD CONSTRAINT "WasteRecord_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WasteRecord" ADD CONSTRAINT "WasteRecord_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WasteRecord" ADD CONSTRAINT "WasteRecord_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "ItemLot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WasteRecord" ADD CONSTRAINT "WasteRecord_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTake" ADD CONSTRAINT "StockTake_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTake" ADD CONSTRAINT "StockTake_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTakeLine" ADD CONSTRAINT "StockTakeLine_stockTakeId_fkey" FOREIGN KEY ("stockTakeId") REFERENCES "StockTake"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTakeLine" ADD CONSTRAINT "StockTakeLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTakeLine" ADD CONSTRAINT "StockTakeLine_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "ItemLot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTakeLine" ADD CONSTRAINT "StockTakeLine_resultingAdjustmentId_fkey" FOREIGN KEY ("resultingAdjustmentId") REFERENCES "StockAdjustment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseRequisitionSequence" ADD CONSTRAINT "PurchaseRequisitionSequence_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseRequisition" ADD CONSTRAINT "PurchaseRequisition_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseRequisition" ADD CONSTRAINT "PurchaseRequisition_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseRequisitionLine" ADD CONSTRAINT "PurchaseRequisitionLine_requisitionId_fkey" FOREIGN KEY ("requisitionId") REFERENCES "PurchaseRequisition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseRequisitionLine" ADD CONSTRAINT "PurchaseRequisitionLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderSequence" ADD CONSTRAINT "PurchaseOrderSequence_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_requisitionId_fkey" FOREIGN KEY ("requisitionId") REFERENCES "PurchaseRequisition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceiptSequence" ADD CONSTRAINT "GoodsReceiptSequence_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_goodsReceiptId_fkey" FOREIGN KEY ("goodsReceiptId") REFERENCES "GoodsReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_purchaseOrderLineId_fkey" FOREIGN KEY ("purchaseOrderLineId") REFERENCES "PurchaseOrderLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Phase 6A hardening: at most one IN_PROGRESS stocktake per location.
CREATE UNIQUE INDEX "stocktake_one_in_progress_per_location"
  ON "StockTake" ("facilityId", "locationId") WHERE status = 'IN_PROGRESS';
