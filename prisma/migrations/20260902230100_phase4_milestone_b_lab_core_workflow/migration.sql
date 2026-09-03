-- CreateTable
CREATE TABLE "LabTestCatalog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "specimenType" TEXT NOT NULL,
    "resultType" TEXT NOT NULL,
    "unit" TEXT,
    "demoPriceInr" REAL NOT NULL DEFAULT 300,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LabTestCatalog_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LabPanel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LabPanel_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LabPanelTest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "panelId" TEXT NOT NULL,
    "catalogTestId" TEXT NOT NULL,
    CONSTRAINT "LabPanelTest_panelId_fkey" FOREIGN KEY ("panelId") REFERENCES "LabPanel" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "LabPanelTest_catalogTestId_fkey" FOREIGN KEY ("catalogTestId") REFERENCES "LabTestCatalog" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LabReferenceRange" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "catalogTestId" TEXT NOT NULL,
    "low" REAL,
    "high" REAL,
    "criticalLow" REAL,
    "criticalHigh" REAL,
    "unit" TEXT,
    "sex" TEXT,
    "minAgeYears" INTEGER,
    "maxAgeYears" INTEGER,
    "effectiveFrom" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" DATETIME,
    "isDemoData" BOOLEAN NOT NULL DEFAULT true,
    "sourceNote" TEXT NOT NULL DEFAULT 'Demo/reference configuration — not clinically validated',
    CONSTRAINT "LabReferenceRange_catalogTestId_fkey" FOREIGN KEY ("catalogTestId") REFERENCES "LabTestCatalog" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Specimen" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "labOrderId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "accessionNumber" TEXT NOT NULL,
    "specimenType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ORDERED',
    "collectedByStaffId" TEXT,
    "collectedAt" DATETIME,
    "collectionNotes" TEXT,
    "receivedByStaffId" TEXT,
    "receivedAt" DATETIME,
    "acceptedByStaffId" TEXT,
    "acceptedAt" DATETIME,
    "rejectedReason" TEXT,
    "rejectedNotes" TEXT,
    "rejectedByStaffId" TEXT,
    "rejectedAt" DATETIME,
    "recollectionOfSpecimenId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Specimen_labOrderId_fkey" FOREIGN KEY ("labOrderId") REFERENCES "LabOrder" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Specimen_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Specimen_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Specimen_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Specimen_recollectionOfSpecimenId_fkey" FOREIGN KEY ("recollectionOfSpecimenId") REFERENCES "Specimen" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_LabOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "encounterId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "testName" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'ROUTINE',
    "orderedByStaffId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ORDERED',
    "orderedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "orderId" TEXT,
    "catalogTestId" TEXT,
    "panelId" TEXT,
    CONSTRAINT "LabOrder_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "LabOrder_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "LabOrder_orderedByStaffId_fkey" FOREIGN KEY ("orderedByStaffId") REFERENCES "HospitalStaffProfile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "LabOrder_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "LabOrder_catalogTestId_fkey" FOREIGN KEY ("catalogTestId") REFERENCES "LabTestCatalog" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "LabOrder_panelId_fkey" FOREIGN KEY ("panelId") REFERENCES "LabPanel" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_LabOrder" ("category", "encounterId", "id", "orderId", "orderedAt", "orderedByStaffId", "patientId", "priority", "status", "testName") SELECT "category", "encounterId", "id", "orderId", "orderedAt", "orderedByStaffId", "patientId", "priority", "status", "testName" FROM "LabOrder";
DROP TABLE "LabOrder";
ALTER TABLE "new_LabOrder" RENAME TO "LabOrder";
CREATE UNIQUE INDEX "LabOrder_orderId_key" ON "LabOrder"("orderId");
CREATE INDEX "LabOrder_encounterId_idx" ON "LabOrder"("encounterId");
CREATE INDEX "LabOrder_status_idx" ON "LabOrder"("status");
CREATE TABLE "new_LabResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "labOrderId" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "unit" TEXT,
    "referenceRange" TEXT,
    "isCritical" BOOLEAN NOT NULL DEFAULT false,
    "releasedByStaffId" TEXT,
    "resultedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedByStaffId" TEXT,
    "acknowledgedAt" DATETIME,
    "specimenId" TEXT,
    "catalogTestId" TEXT,
    "resultType" TEXT,
    "numericValue" REAL,
    "abnormalFlag" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ENTERED',
    "verifiedByStaffId" TEXT,
    "verifiedAt" DATETIME,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "previousVersionId" TEXT,
    "amendedReason" TEXT,
    "amendedByStaffId" TEXT,
    "amendedAt" DATETIME,
    CONSTRAINT "LabResult_labOrderId_fkey" FOREIGN KEY ("labOrderId") REFERENCES "LabOrder" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "LabResult_releasedByStaffId_fkey" FOREIGN KEY ("releasedByStaffId") REFERENCES "HospitalStaffProfile" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "LabResult_specimenId_fkey" FOREIGN KEY ("specimenId") REFERENCES "Specimen" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "LabResult_catalogTestId_fkey" FOREIGN KEY ("catalogTestId") REFERENCES "LabTestCatalog" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "LabResult_previousVersionId_fkey" FOREIGN KEY ("previousVersionId") REFERENCES "LabResult" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_LabResult" ("acknowledgedAt", "acknowledgedByStaffId", "id", "isCritical", "labOrderId", "referenceRange", "releasedByStaffId", "resultedAt", "unit", "value") SELECT "acknowledgedAt", "acknowledgedByStaffId", "id", "isCritical", "labOrderId", "referenceRange", "releasedByStaffId", "resultedAt", "unit", "value" FROM "LabResult";
DROP TABLE "LabResult";
ALTER TABLE "new_LabResult" RENAME TO "LabResult";
CREATE UNIQUE INDEX "LabResult_previousVersionId_key" ON "LabResult"("previousVersionId");
CREATE INDEX "LabResult_labOrderId_idx" ON "LabResult"("labOrderId");
CREATE INDEX "LabResult_specimenId_idx" ON "LabResult"("specimenId");
CREATE INDEX "LabResult_isCurrent_idx" ON "LabResult"("isCurrent");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "LabTestCatalog_code_key" ON "LabTestCatalog"("code");

-- CreateIndex
CREATE INDEX "LabTestCatalog_facilityId_idx" ON "LabTestCatalog"("facilityId");

-- CreateIndex
CREATE INDEX "LabTestCatalog_category_idx" ON "LabTestCatalog"("category");

-- CreateIndex
CREATE UNIQUE INDEX "LabPanel_code_key" ON "LabPanel"("code");

-- CreateIndex
CREATE INDEX "LabPanel_facilityId_idx" ON "LabPanel"("facilityId");

-- CreateIndex
CREATE UNIQUE INDEX "LabPanelTest_panelId_catalogTestId_key" ON "LabPanelTest"("panelId", "catalogTestId");

-- CreateIndex
CREATE INDEX "LabReferenceRange_catalogTestId_idx" ON "LabReferenceRange"("catalogTestId");

-- CreateIndex
CREATE INDEX "Specimen_labOrderId_idx" ON "Specimen"("labOrderId");

-- CreateIndex
CREATE INDEX "Specimen_status_idx" ON "Specimen"("status");

-- CreateIndex
CREATE INDEX "Specimen_patientId_idx" ON "Specimen"("patientId");

-- CreateIndex
CREATE UNIQUE INDEX "Specimen_facilityId_accessionNumber_key" ON "Specimen"("facilityId", "accessionNumber");
