-- CreateTable
CREATE TABLE "ImagingStudy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "imagingOrderId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "accessionNumber" TEXT NOT NULL,
    "modality" TEXT NOT NULL,
    "bodyRegion" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "resourceId" TEXT,
    "scheduledAt" DATETIME NOT NULL,
    "arrivedAt" DATETIME,
    "startedAt" DATETIME,
    "performedAt" DATETIME,
    "performedByStaffId" TEXT,
    "contrastRequired" BOOLEAN NOT NULL DEFAULT false,
    "contrastGiven" BOOLEAN NOT NULL DEFAULT false,
    "pregnancyScreened" BOOLEAN NOT NULL DEFAULT false,
    "allergyScreened" BOOLEAN NOT NULL DEFAULT false,
    "mriSafetyScreened" BOOLEAN NOT NULL DEFAULT false,
    "implantScreened" BOOLEAN NOT NULL DEFAULT false,
    "preparationCompleted" BOOLEAN NOT NULL DEFAULT false,
    "cancelledReason" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ImagingStudy_imagingOrderId_fkey" FOREIGN KEY ("imagingOrderId") REFERENCES "ImagingOrder" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ImagingStudy_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ImagingStudy_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ImagingStudy_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ImagingStudy_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "ImagingResource" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ImagingCatalog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "modality" TEXT NOT NULL,
    "bodyRegion" TEXT,
    "description" TEXT,
    "contrastRequired" BOOLEAN NOT NULL DEFAULT false,
    "prepInstructions" TEXT,
    "defaultDurationMinutes" INTEGER NOT NULL DEFAULT 30,
    "demoPriceInr" REAL NOT NULL DEFAULT 1500,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ImagingCatalog_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ImagingResource" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "modality" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "ImagingResource_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ImagingOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "encounterId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "modality" TEXT NOT NULL,
    "studyDescription" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'ROUTINE',
    "orderedByStaffId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ORDERED',
    "orderedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "orderId" TEXT,
    "catalogStudyId" TEXT,
    CONSTRAINT "ImagingOrder_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ImagingOrder_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ImagingOrder_orderedByStaffId_fkey" FOREIGN KEY ("orderedByStaffId") REFERENCES "HospitalStaffProfile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ImagingOrder_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ImagingOrder_catalogStudyId_fkey" FOREIGN KEY ("catalogStudyId") REFERENCES "ImagingCatalog" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ImagingOrder" ("encounterId", "id", "modality", "orderId", "orderedAt", "orderedByStaffId", "patientId", "priority", "status", "studyDescription") SELECT "encounterId", "id", "modality", "orderId", "orderedAt", "orderedByStaffId", "patientId", "priority", "status", "studyDescription" FROM "ImagingOrder";
DROP TABLE "ImagingOrder";
ALTER TABLE "new_ImagingOrder" RENAME TO "ImagingOrder";
CREATE UNIQUE INDEX "ImagingOrder_orderId_key" ON "ImagingOrder"("orderId");
CREATE INDEX "ImagingOrder_encounterId_idx" ON "ImagingOrder"("encounterId");
CREATE INDEX "ImagingOrder_status_idx" ON "ImagingOrder"("status");
CREATE TABLE "new_ImagingReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "studyId" TEXT,
    "imagingOrderId" TEXT NOT NULL,
    "indication" TEXT,
    "technique" TEXT,
    "findings" TEXT NOT NULL,
    "impression" TEXT NOT NULL,
    "recommendations" TEXT,
    "isCritical" BOOLEAN NOT NULL DEFAULT false,
    "reportedByStaffId" TEXT NOT NULL,
    "reportedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'ENTERED',
    "verifiedByStaffId" TEXT,
    "verifiedAt" DATETIME,
    "acknowledgedByStaffId" TEXT,
    "acknowledgedAt" DATETIME,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "previousVersionId" TEXT,
    "amendedReason" TEXT,
    "amendedByStaffId" TEXT,
    "amendedAt" DATETIME,
    CONSTRAINT "ImagingReport_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "ImagingStudy" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ImagingReport_imagingOrderId_fkey" FOREIGN KEY ("imagingOrderId") REFERENCES "ImagingOrder" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ImagingReport_reportedByStaffId_fkey" FOREIGN KEY ("reportedByStaffId") REFERENCES "HospitalStaffProfile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ImagingReport_previousVersionId_fkey" FOREIGN KEY ("previousVersionId") REFERENCES "ImagingReport" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ImagingReport" ("findings", "id", "imagingOrderId", "impression", "isCritical", "reportedAt", "reportedByStaffId", "verifiedAt", "verifiedByStaffId") SELECT "findings", "id", "imagingOrderId", "impression", "isCritical", "reportedAt", "reportedByStaffId", "verifiedAt", "verifiedByStaffId" FROM "ImagingReport";
DROP TABLE "ImagingReport";
ALTER TABLE "new_ImagingReport" RENAME TO "ImagingReport";
CREATE UNIQUE INDEX "ImagingReport_previousVersionId_key" ON "ImagingReport"("previousVersionId");
CREATE INDEX "ImagingReport_studyId_idx" ON "ImagingReport"("studyId");
CREATE INDEX "ImagingReport_imagingOrderId_idx" ON "ImagingReport"("imagingOrderId");
CREATE INDEX "ImagingReport_isCurrent_idx" ON "ImagingReport"("isCurrent");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "ImagingStudy_imagingOrderId_idx" ON "ImagingStudy"("imagingOrderId");

-- CreateIndex
CREATE INDEX "ImagingStudy_status_idx" ON "ImagingStudy"("status");

-- CreateIndex
CREATE INDEX "ImagingStudy_resourceId_scheduledAt_idx" ON "ImagingStudy"("resourceId", "scheduledAt");

-- CreateIndex
CREATE UNIQUE INDEX "ImagingStudy_facilityId_accessionNumber_key" ON "ImagingStudy"("facilityId", "accessionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "ImagingCatalog_code_key" ON "ImagingCatalog"("code");

-- CreateIndex
CREATE INDEX "ImagingCatalog_facilityId_idx" ON "ImagingCatalog"("facilityId");

-- CreateIndex
CREATE INDEX "ImagingCatalog_modality_idx" ON "ImagingCatalog"("modality");

-- CreateIndex
CREATE INDEX "ImagingResource_facilityId_idx" ON "ImagingResource"("facilityId");
