-- AlterTable
ALTER TABLE "ImagingResource" ADD COLUMN "capabilities" JSONB;
ALTER TABLE "ImagingResource" ADD COLUMN "location" TEXT;
ALTER TABLE "ImagingResource" ADD COLUMN "roomLabel" TEXT;

-- AlterTable
ALTER TABLE "Specimen" ADD COLUMN "barcode" TEXT;
ALTER TABLE "Specimen" ADD COLUMN "containerType" TEXT;

-- CreateTable
CREATE TABLE "LabQcRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "catalogTestId" TEXT,
    "instrumentId" TEXT NOT NULL,
    "runAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "controlType" TEXT NOT NULL,
    "controlLot" TEXT,
    "observedValue" REAL,
    "expectedValue" REAL,
    "unit" TEXT,
    "result" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "performedByStaffId" TEXT NOT NULL,
    "reviewedByStaffId" TEXT,
    "reviewedAt" DATETIME,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "LabCalibrationRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "calibrationType" TEXT NOT NULL,
    "calibratedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "performedByStaffId" TEXT NOT NULL,
    "reviewedByStaffId" TEXT,
    "reviewedAt" DATETIME,
    "nextDueAt" DATETIME,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ExternalLabReferral" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "labOrderId" TEXT,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT,
    "externalLabName" TEXT NOT NULL,
    "externalAccession" TEXT,
    "testDescription" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "sentByStaffId" TEXT NOT NULL,
    "sentAt" DATETIME,
    "resultReceivedAt" DATETIME,
    "resultDocumentRef" TEXT,
    "reviewedByStaffId" TEXT,
    "reviewedAt" DATETIME,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ImagingStudy" (
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
    "scheduledEndAt" DATETIME NOT NULL,
    "arrivedAt" DATETIME,
    "startedAt" DATETIME,
    "performedAt" DATETIME,
    "performedByStaffId" TEXT,
    "contrastRequired" BOOLEAN NOT NULL DEFAULT false,
    "contrastGiven" BOOLEAN NOT NULL DEFAULT false,
    "studyInstanceUid" TEXT,
    "seriesUid" TEXT,
    "numberOfImages" INTEGER,
    "pacsReference" TEXT,
    "imageAvailability" TEXT NOT NULL DEFAULT 'NONE',
    "acquisitionAt" DATETIME,
    "technicalNotes" TEXT,
    "dicomMetadata" JSONB,
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
INSERT INTO "new_ImagingStudy" ("accessionNumber", "allergyScreened", "arrivedAt", "bodyRegion", "cancelledReason", "contrastGiven", "contrastRequired", "createdAt", "encounterId", "facilityId", "id", "imagingOrderId", "implantScreened", "modality", "mriSafetyScreened", "notes", "patientId", "performedAt", "performedByStaffId", "pregnancyScreened", "preparationCompleted", "resourceId", "scheduledAt", "scheduledEndAt", "startedAt", "status") SELECT "accessionNumber", "allergyScreened", "arrivedAt", "bodyRegion", "cancelledReason", "contrastGiven", "contrastRequired", "createdAt", "encounterId", "facilityId", "id", "imagingOrderId", "implantScreened", "modality", "mriSafetyScreened", "notes", "patientId", "performedAt", "performedByStaffId", "pregnancyScreened", "preparationCompleted", "resourceId", "scheduledAt", "scheduledEndAt", "startedAt", "status" FROM "ImagingStudy";
DROP TABLE "ImagingStudy";
ALTER TABLE "new_ImagingStudy" RENAME TO "ImagingStudy";
CREATE INDEX "ImagingStudy_imagingOrderId_idx" ON "ImagingStudy"("imagingOrderId");
CREATE INDEX "ImagingStudy_status_idx" ON "ImagingStudy"("status");
CREATE INDEX "ImagingStudy_resourceId_scheduledAt_idx" ON "ImagingStudy"("resourceId", "scheduledAt");
CREATE INDEX "ImagingStudy_facilityId_status_idx" ON "ImagingStudy"("facilityId", "status");
CREATE UNIQUE INDEX "ImagingStudy_facilityId_accessionNumber_key" ON "ImagingStudy"("facilityId", "accessionNumber");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "LabQcRecord_facilityId_status_idx" ON "LabQcRecord"("facilityId", "status");

-- CreateIndex
CREATE INDEX "LabQcRecord_instrumentId_idx" ON "LabQcRecord"("instrumentId");

-- CreateIndex
CREATE INDEX "LabCalibrationRecord_facilityId_status_idx" ON "LabCalibrationRecord"("facilityId", "status");

-- CreateIndex
CREATE INDEX "LabCalibrationRecord_instrumentId_idx" ON "LabCalibrationRecord"("instrumentId");

-- CreateIndex
CREATE INDEX "ExternalLabReferral_facilityId_status_idx" ON "ExternalLabReferral"("facilityId", "status");

-- CreateIndex
CREATE INDEX "ExternalLabReferral_patientId_idx" ON "ExternalLabReferral"("patientId");

-- CreateIndex
CREATE INDEX "ExternalLabReferral_labOrderId_idx" ON "ExternalLabReferral"("labOrderId");
