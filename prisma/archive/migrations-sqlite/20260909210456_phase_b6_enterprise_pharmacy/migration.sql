-- AlterTable
ALTER TABLE "DispensingRecord" ADD COLUMN "dispenseGroupId" TEXT;
ALTER TABLE "DispensingRecord" ADD COLUMN "itemId" TEXT;
ALTER TABLE "DispensingRecord" ADD COLUMN "itemLotId" TEXT;

-- CreateTable
CREATE TABLE "FormularyEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "effectiveFrom" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" DATETIME,
    "restrictions" TEXT,
    "requiresAuthorization" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdByStaffId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "FormularyEntry_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "FormularyEntry_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PharmacyRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" REAL NOT NULL,
    "unit" TEXT,
    "requestingLocationId" TEXT,
    "fulfillLocationId" TEXT,
    "patientId" TEXT,
    "encounterId" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'ROUTINE',
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "requestedByStaffId" TEXT NOT NULL,
    "reviewedByStaffId" TEXT,
    "reservationId" TEXT,
    "transferId" TEXT,
    "reason" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "MedicationReturn" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "medicationOrderId" TEXT,
    "itemId" TEXT NOT NULL,
    "itemLotId" TEXT,
    "locationId" TEXT NOT NULL,
    "quantity" REAL NOT NULL,
    "unit" TEXT,
    "source" TEXT NOT NULL,
    "classification" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING_INSPECTION',
    "patientId" TEXT,
    "encounterId" TEXT,
    "isControlled" BOOLEAN NOT NULL DEFAULT false,
    "witnessStaffId" TEXT,
    "returnedByStaffId" TEXT NOT NULL,
    "inspectedByStaffId" TEXT,
    "reason" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MedicationReturn_medicationOrderId_fkey" FOREIGN KEY ("medicationOrderId") REFERENCES "MedicationOrder" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MedicationRecall" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "itemLotId" TEXT,
    "manufacturer" TEXT,
    "batchRef" TEXT,
    "reason" TEXT NOT NULL,
    "reference" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "effectiveAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "affectedLocations" JSONB,
    "createdByStaffId" TEXT NOT NULL,
    "closedByStaffId" TEXT,
    "closedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "MedicationSubstitution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "medicationOrderId" TEXT NOT NULL,
    "originalDrugName" TEXT NOT NULL,
    "replacementItemId" TEXT,
    "replacementDrugName" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "authorizedByStaffId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MedicationSubstitution_medicationOrderId_fkey" FOREIGN KEY ("medicationOrderId") REFERENCES "MedicationOrder" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PharmacyStorageCheck" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "recordedValue" REAL NOT NULL,
    "unit" TEXT NOT NULL,
    "status" TEXT,
    "recordedByStaffId" TEXT NOT NULL,
    "notes" TEXT,
    "checkedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Item" (
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
    "genericName" TEXT,
    "brandName" TEXT,
    "strength" TEXT,
    "dosageForm" TEXT,
    "medicationRoute" TEXT,
    "concentration" TEXT,
    "therapeuticCategory" TEXT,
    "controlledClass" TEXT,
    "highAlert" BOOLEAN NOT NULL DEFAULT false,
    "storageRequirement" TEXT,
    "barcode" TEXT,
    "manufacturer" TEXT,
    "packSize" TEXT,
    "dispensingUnit" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Item_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Item_preferredSupplierId_fkey" FOREIGN KEY ("preferredSupplierId") REFERENCES "Supplier" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Item" ("active", "baseUnit", "category", "createdAt", "description", "facilityId", "id", "name", "preferredSupplierId", "reorderMaxLevel", "reorderMinLevel", "reorderPoint", "reorderQuantity", "sku", "trackExpiry", "trackLots", "trackSerial", "updatedAt") SELECT "active", "baseUnit", "category", "createdAt", "description", "facilityId", "id", "name", "preferredSupplierId", "reorderMaxLevel", "reorderMinLevel", "reorderPoint", "reorderQuantity", "sku", "trackExpiry", "trackLots", "trackSerial", "updatedAt" FROM "Item";
DROP TABLE "Item";
ALTER TABLE "new_Item" RENAME TO "Item";
CREATE UNIQUE INDEX "Item_sku_key" ON "Item"("sku");
CREATE INDEX "Item_facilityId_idx" ON "Item"("facilityId");
CREATE INDEX "Item_category_idx" ON "Item"("category");
CREATE TABLE "new_MedicationOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "encounterId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "drugName" TEXT NOT NULL,
    "genericName" TEXT,
    "dose" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "durationDays" INTEGER,
    "orderedByStaffId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ORDERED',
    "safetyFlags" JSONB,
    "overrideReason" TEXT,
    "orderedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "orderId" TEXT,
    "formulation" TEXT,
    "strengthValue" REAL,
    "strengthUnit" TEXT,
    "doseValue" REAL,
    "doseUnit" TEXT,
    "timing" TEXT,
    "startAt" DATETIME,
    "stopAt" DATETIME,
    "prn" BOOLEAN NOT NULL DEFAULT false,
    "prnReason" TEXT,
    "specialInstructions" TEXT,
    "indication" TEXT,
    "isControlled" BOOLEAN NOT NULL DEFAULT false,
    "discontinuedAt" DATETIME,
    "discontinuedReason" TEXT,
    "discontinuedByStaffId" TEXT,
    "cancelledAt" DATETIME,
    "cancelledReason" TEXT,
    "cancelledByStaffId" TEXT,
    "dispenseTargetQuantity" REAL,
    "dispenseTargetUnit" TEXT,
    "dispensedQuantity" REAL NOT NULL DEFAULT 0,
    CONSTRAINT "MedicationOrder_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "MedicationOrder_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "MedicationOrder_orderedByStaffId_fkey" FOREIGN KEY ("orderedByStaffId") REFERENCES "HospitalStaffProfile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "MedicationOrder_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_MedicationOrder" ("cancelledAt", "cancelledByStaffId", "cancelledReason", "discontinuedAt", "discontinuedByStaffId", "discontinuedReason", "dose", "doseUnit", "doseValue", "drugName", "durationDays", "encounterId", "formulation", "frequency", "genericName", "id", "indication", "isControlled", "orderId", "orderedAt", "orderedByStaffId", "overrideReason", "patientId", "prn", "prnReason", "route", "safetyFlags", "specialInstructions", "startAt", "status", "stopAt", "strengthUnit", "strengthValue", "timing") SELECT "cancelledAt", "cancelledByStaffId", "cancelledReason", "discontinuedAt", "discontinuedByStaffId", "discontinuedReason", "dose", "doseUnit", "doseValue", "drugName", "durationDays", "encounterId", "formulation", "frequency", "genericName", "id", "indication", "isControlled", "orderId", "orderedAt", "orderedByStaffId", "overrideReason", "patientId", "prn", "prnReason", "route", "safetyFlags", "specialInstructions", "startAt", "status", "stopAt", "strengthUnit", "strengthValue", "timing" FROM "MedicationOrder";
DROP TABLE "MedicationOrder";
ALTER TABLE "new_MedicationOrder" RENAME TO "MedicationOrder";
CREATE UNIQUE INDEX "MedicationOrder_orderId_key" ON "MedicationOrder"("orderId");
CREATE INDEX "MedicationOrder_encounterId_idx" ON "MedicationOrder"("encounterId");
CREATE INDEX "MedicationOrder_patientId_idx" ON "MedicationOrder"("patientId");
CREATE INDEX "MedicationOrder_status_idx" ON "MedicationOrder"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "FormularyEntry_facilityId_itemId_idx" ON "FormularyEntry"("facilityId", "itemId");

-- CreateIndex
CREATE INDEX "FormularyEntry_facilityId_active_idx" ON "FormularyEntry"("facilityId", "active");

-- CreateIndex
CREATE INDEX "PharmacyRequest_facilityId_status_idx" ON "PharmacyRequest"("facilityId", "status");

-- CreateIndex
CREATE INDEX "PharmacyRequest_itemId_idx" ON "PharmacyRequest"("itemId");

-- CreateIndex
CREATE INDEX "PharmacyRequest_encounterId_idx" ON "PharmacyRequest"("encounterId");

-- CreateIndex
CREATE INDEX "MedicationReturn_facilityId_status_idx" ON "MedicationReturn"("facilityId", "status");

-- CreateIndex
CREATE INDEX "MedicationReturn_itemId_idx" ON "MedicationReturn"("itemId");

-- CreateIndex
CREATE INDEX "MedicationReturn_medicationOrderId_idx" ON "MedicationReturn"("medicationOrderId");

-- CreateIndex
CREATE INDEX "MedicationRecall_facilityId_status_idx" ON "MedicationRecall"("facilityId", "status");

-- CreateIndex
CREATE INDEX "MedicationRecall_itemId_idx" ON "MedicationRecall"("itemId");

-- CreateIndex
CREATE INDEX "MedicationRecall_itemLotId_idx" ON "MedicationRecall"("itemLotId");

-- CreateIndex
CREATE INDEX "MedicationSubstitution_facilityId_idx" ON "MedicationSubstitution"("facilityId");

-- CreateIndex
CREATE INDEX "MedicationSubstitution_medicationOrderId_idx" ON "MedicationSubstitution"("medicationOrderId");

-- CreateIndex
CREATE INDEX "PharmacyStorageCheck_facilityId_locationId_idx" ON "PharmacyStorageCheck"("facilityId", "locationId");

-- CreateIndex
CREATE INDEX "DispensingRecord_dispenseGroupId_idx" ON "DispensingRecord"("dispenseGroupId");

-- CreateIndex
CREATE INDEX "DispensingRecord_itemLotId_idx" ON "DispensingRecord"("itemLotId");
