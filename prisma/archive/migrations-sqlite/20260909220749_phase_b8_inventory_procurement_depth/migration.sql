-- AlterTable
ALTER TABLE "GoodsReceiptLine" ADD COLUMN "unitCostMinor" INTEGER;

-- AlterTable
ALTER TABLE "ItemLot" ADD COLUMN "unitCostMinor" INTEGER;

-- AlterTable
ALTER TABLE "Supplier" ADD COLUMN "bankAccountRef" TEXT;
ALTER TABLE "Supplier" ADD COLUMN "categories" JSONB;
ALTER TABLE "Supplier" ADD COLUMN "complianceNote" TEXT;
ALTER TABLE "Supplier" ADD COLUMN "gstNumber" TEXT;
ALTER TABLE "Supplier" ADD COLUMN "legalName" TEXT;
ALTER TABLE "Supplier" ADD COLUMN "panNumber" TEXT;
ALTER TABLE "Supplier" ADD COLUMN "slaNote" TEXT;
ALTER TABLE "Supplier" ADD COLUMN "tradeName" TEXT;

-- CreateTable
CREATE TABLE "SupplierContract" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "agreedPriceMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "effectiveFrom" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" DATETIME,
    "moq" REAL,
    "leadTimeDays" INTEGER,
    "paymentTermsDays" INTEGER,
    "contractRef" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdByStaffId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SupplierContract_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Rfq" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "rfqNumber" TEXT,
    "requisitionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "validUntil" DATETIME,
    "notes" TEXT,
    "createdByStaffId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "RfqLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "rfqId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" REAL NOT NULL,
    "unit" TEXT NOT NULL,
    CONSTRAINT "RfqLine_rfqId_fkey" FOREIGN KEY ("rfqId") REFERENCES "Rfq" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RfqQuotation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "rfqId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "subtotalMinor" INTEGER NOT NULL DEFAULT 0,
    "taxMinor" INTEGER NOT NULL DEFAULT 0,
    "totalMinor" INTEGER NOT NULL DEFAULT 0,
    "deliveryDays" INTEGER,
    "validUntil" DATETIME,
    "notes" TEXT,
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "recordedByStaffId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RfqQuotation_rfqId_fkey" FOREIGN KEY ("rfqId") REFERENCES "Rfq" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "RfqQuotation_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RfqQuotationLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "quotationId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "unitPriceMinor" INTEGER NOT NULL,
    "taxPercent" REAL NOT NULL DEFAULT 0,
    "lineTotalMinor" INTEGER NOT NULL,
    CONSTRAINT "RfqQuotationLine_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "RfqQuotation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SupplierInvoice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "purchaseOrderId" TEXT,
    "invoiceRef" TEXT NOT NULL,
    "invoiceDate" DATETIME,
    "totalMinor" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "quantityMismatch" BOOLEAN NOT NULL DEFAULT false,
    "priceMismatch" BOOLEAN NOT NULL DEFAULT false,
    "missingReceipt" BOOLEAN NOT NULL DEFAULT false,
    "matchNotes" TEXT,
    "recordedByStaffId" TEXT NOT NULL,
    "reviewedByStaffId" TEXT,
    "reviewedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SupplierInvoice_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DepartmentSupplyRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "departmentId" TEXT,
    "requestingLocationId" TEXT,
    "fulfillLocationId" TEXT,
    "itemId" TEXT NOT NULL,
    "quantity" REAL NOT NULL,
    "unit" TEXT,
    "urgency" TEXT NOT NULL DEFAULT 'ROUTINE',
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "patientId" TEXT,
    "encounterId" TEXT,
    "requestedByStaffId" TEXT NOT NULL,
    "reviewedByStaffId" TEXT,
    "reservationId" TEXT,
    "transferId" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "InventorySerial" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "lotId" TEXT,
    "serialNumber" TEXT NOT NULL,
    "currentLocationId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'IN_STOCK',
    "receivedAt" DATETIME,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "SupplierContract_facilityId_itemId_active_idx" ON "SupplierContract"("facilityId", "itemId", "active");

-- CreateIndex
CREATE INDEX "SupplierContract_supplierId_idx" ON "SupplierContract"("supplierId");

-- CreateIndex
CREATE INDEX "Rfq_facilityId_status_idx" ON "Rfq"("facilityId", "status");

-- CreateIndex
CREATE INDEX "RfqLine_rfqId_idx" ON "RfqLine"("rfqId");

-- CreateIndex
CREATE INDEX "RfqQuotation_facilityId_idx" ON "RfqQuotation"("facilityId");

-- CreateIndex
CREATE UNIQUE INDEX "RfqQuotation_rfqId_supplierId_key" ON "RfqQuotation"("rfqId", "supplierId");

-- CreateIndex
CREATE INDEX "RfqQuotationLine_quotationId_idx" ON "RfqQuotationLine"("quotationId");

-- CreateIndex
CREATE INDEX "SupplierInvoice_facilityId_status_idx" ON "SupplierInvoice"("facilityId", "status");

-- CreateIndex
CREATE INDEX "SupplierInvoice_purchaseOrderId_idx" ON "SupplierInvoice"("purchaseOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierInvoice_facilityId_supplierId_invoiceRef_key" ON "SupplierInvoice"("facilityId", "supplierId", "invoiceRef");

-- CreateIndex
CREATE INDEX "DepartmentSupplyRequest_facilityId_status_idx" ON "DepartmentSupplyRequest"("facilityId", "status");

-- CreateIndex
CREATE INDEX "DepartmentSupplyRequest_itemId_idx" ON "DepartmentSupplyRequest"("itemId");

-- CreateIndex
CREATE INDEX "InventorySerial_facilityId_itemId_status_idx" ON "InventorySerial"("facilityId", "itemId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "InventorySerial_facilityId_serialNumber_key" ON "InventorySerial"("facilityId", "serialNumber");
