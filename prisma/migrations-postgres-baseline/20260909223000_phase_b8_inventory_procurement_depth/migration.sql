-- Phase B8 Enterprise Inventory + Procurement Depth. Additive; mirrors
-- prisma/migrations/20260909220749_phase_b8_inventory_procurement_depth. ONE
-- canonical supply chain — adds RFQ/vendor-comparison, effective supplier
-- pricing/contracts, the supplier-invoice three-way-match boundary, a generic
-- department supply request, minimal serialized-item identity, the missing
-- PROCUREMENT_OFFICER role, and costing columns (ItemLot/GoodsReceiptLine
-- unitCostMinor). No second inventory, no destructive change.

-- AlterEnum (the dedicated procurement role Phase 6A flagged as missing)
ALTER TYPE "Role" ADD VALUE 'PROCUREMENT_OFFICER';

-- CreateEnum
CREATE TYPE "RfqStatus" AS ENUM ('DRAFT', 'SENT', 'CLOSED', 'CANCELLED');
CREATE TYPE "RfqQuotationStatus" AS ENUM ('PENDING', 'SUBMITTED', 'SELECTED', 'REJECTED');
CREATE TYPE "SupplierInvoiceStatus" AS ENUM ('RECEIVED', 'MATCHED', 'DISCREPANCY', 'APPROVED', 'REJECTED');
CREATE TYPE "DepartmentSupplyRequestStatus" AS ENUM ('REQUESTED', 'APPROVED', 'RESERVED', 'ISSUED', 'RECEIVED', 'CANCELLED', 'REJECTED');
CREATE TYPE "InventorySerialStatus" AS ENUM ('IN_STOCK', 'RESERVED', 'ISSUED', 'RETURNED', 'DISPOSED');

-- AlterTable (costing columns — additive)
ALTER TABLE "ItemLot" ADD COLUMN "unitCostMinor" INTEGER;
ALTER TABLE "GoodsReceiptLine" ADD COLUMN "unitCostMinor" INTEGER;

-- AlterTable (supplier-master depth — additive)
ALTER TABLE "Supplier" ADD COLUMN "legalName" TEXT;
ALTER TABLE "Supplier" ADD COLUMN "tradeName" TEXT;
ALTER TABLE "Supplier" ADD COLUMN "gstNumber" TEXT;
ALTER TABLE "Supplier" ADD COLUMN "panNumber" TEXT;
ALTER TABLE "Supplier" ADD COLUMN "bankAccountRef" TEXT;
ALTER TABLE "Supplier" ADD COLUMN "categories" JSONB;
ALTER TABLE "Supplier" ADD COLUMN "complianceNote" TEXT;
ALTER TABLE "Supplier" ADD COLUMN "slaNote" TEXT;

-- CreateTable
CREATE TABLE "SupplierContract" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "agreedPriceMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "moq" DOUBLE PRECISION,
    "leadTimeDays" INTEGER,
    "paymentTermsDays" INTEGER,
    "contractRef" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdByStaffId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SupplierContract_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Rfq" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "rfqNumber" TEXT,
    "requisitionId" TEXT,
    "status" "RfqStatus" NOT NULL DEFAULT 'DRAFT',
    "validUntil" TIMESTAMP(3),
    "notes" TEXT,
    "createdByStaffId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Rfq_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RfqLine" (
    "id" TEXT NOT NULL,
    "rfqId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" "UnitOfMeasure" NOT NULL,
    CONSTRAINT "RfqLine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RfqQuotation" (
    "id" TEXT NOT NULL,
    "rfqId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "status" "RfqQuotationStatus" NOT NULL DEFAULT 'PENDING',
    "subtotalMinor" INTEGER NOT NULL DEFAULT 0,
    "taxMinor" INTEGER NOT NULL DEFAULT 0,
    "totalMinor" INTEGER NOT NULL DEFAULT 0,
    "deliveryDays" INTEGER,
    "validUntil" TIMESTAMP(3),
    "notes" TEXT,
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "recordedByStaffId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RfqQuotation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RfqQuotationLine" (
    "id" TEXT NOT NULL,
    "quotationId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "unitPriceMinor" INTEGER NOT NULL,
    "taxPercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lineTotalMinor" INTEGER NOT NULL,
    CONSTRAINT "RfqQuotationLine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SupplierInvoice" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "purchaseOrderId" TEXT,
    "invoiceRef" TEXT NOT NULL,
    "invoiceDate" TIMESTAMP(3),
    "totalMinor" INTEGER NOT NULL,
    "status" "SupplierInvoiceStatus" NOT NULL DEFAULT 'RECEIVED',
    "quantityMismatch" BOOLEAN NOT NULL DEFAULT false,
    "priceMismatch" BOOLEAN NOT NULL DEFAULT false,
    "missingReceipt" BOOLEAN NOT NULL DEFAULT false,
    "matchNotes" TEXT,
    "recordedByStaffId" TEXT NOT NULL,
    "reviewedByStaffId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SupplierInvoice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DepartmentSupplyRequest" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "departmentId" TEXT,
    "requestingLocationId" TEXT,
    "fulfillLocationId" TEXT,
    "itemId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" TEXT,
    "urgency" TEXT NOT NULL DEFAULT 'ROUTINE',
    "reason" TEXT,
    "status" "DepartmentSupplyRequestStatus" NOT NULL DEFAULT 'REQUESTED',
    "patientId" TEXT,
    "encounterId" TEXT,
    "requestedByStaffId" TEXT NOT NULL,
    "reviewedByStaffId" TEXT,
    "reservationId" TEXT,
    "transferId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DepartmentSupplyRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InventorySerial" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "lotId" TEXT,
    "serialNumber" TEXT NOT NULL,
    "currentLocationId" TEXT,
    "status" "InventorySerialStatus" NOT NULL DEFAULT 'IN_STOCK',
    "receivedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "InventorySerial_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupplierContract_facilityId_itemId_active_idx" ON "SupplierContract"("facilityId", "itemId", "active");
CREATE INDEX "SupplierContract_supplierId_idx" ON "SupplierContract"("supplierId");
CREATE INDEX "Rfq_facilityId_status_idx" ON "Rfq"("facilityId", "status");
CREATE INDEX "RfqLine_rfqId_idx" ON "RfqLine"("rfqId");
CREATE UNIQUE INDEX "RfqQuotation_rfqId_supplierId_key" ON "RfqQuotation"("rfqId", "supplierId");
CREATE INDEX "RfqQuotation_facilityId_idx" ON "RfqQuotation"("facilityId");
CREATE INDEX "RfqQuotationLine_quotationId_idx" ON "RfqQuotationLine"("quotationId");
CREATE UNIQUE INDEX "SupplierInvoice_facilityId_supplierId_invoiceRef_key" ON "SupplierInvoice"("facilityId", "supplierId", "invoiceRef");
CREATE INDEX "SupplierInvoice_facilityId_status_idx" ON "SupplierInvoice"("facilityId", "status");
CREATE INDEX "SupplierInvoice_purchaseOrderId_idx" ON "SupplierInvoice"("purchaseOrderId");
CREATE INDEX "DepartmentSupplyRequest_facilityId_status_idx" ON "DepartmentSupplyRequest"("facilityId", "status");
CREATE INDEX "DepartmentSupplyRequest_itemId_idx" ON "DepartmentSupplyRequest"("itemId");
CREATE UNIQUE INDEX "InventorySerial_facilityId_serialNumber_key" ON "InventorySerial"("facilityId", "serialNumber");
CREATE INDEX "InventorySerial_facilityId_itemId_status_idx" ON "InventorySerial"("facilityId", "itemId", "status");

-- AddForeignKey
ALTER TABLE "SupplierContract" ADD CONSTRAINT "SupplierContract_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RfqLine" ADD CONSTRAINT "RfqLine_rfqId_fkey" FOREIGN KEY ("rfqId") REFERENCES "Rfq"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RfqQuotation" ADD CONSTRAINT "RfqQuotation_rfqId_fkey" FOREIGN KEY ("rfqId") REFERENCES "Rfq"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RfqQuotation" ADD CONSTRAINT "RfqQuotation_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RfqQuotationLine" ADD CONSTRAINT "RfqQuotationLine_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "RfqQuotation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierInvoice" ADD CONSTRAINT "SupplierInvoice_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
