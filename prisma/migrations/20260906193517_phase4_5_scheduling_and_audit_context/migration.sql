/*
  Warnings:

  - Added the required column `scheduledEndAt` to the `ImagingStudy` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AuditEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "userId" TEXT,
    "detail" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "facilityId" TEXT,
    "patientId" TEXT,
    "encounterId" TEXT,
    CONSTRAINT "AuditEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AuditEvent_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AuditEvent_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_AuditEvent" ("createdAt", "detail", "id", "type", "userId") SELECT "createdAt", "detail", "id", "type", "userId" FROM "AuditEvent";
DROP TABLE "AuditEvent";
ALTER TABLE "new_AuditEvent" RENAME TO "AuditEvent";
CREATE INDEX "AuditEvent_type_idx" ON "AuditEvent"("type");
CREATE INDEX "AuditEvent_userId_idx" ON "AuditEvent"("userId");
CREATE INDEX "AuditEvent_facilityId_idx" ON "AuditEvent"("facilityId");
CREATE INDEX "AuditEvent_patientId_idx" ON "AuditEvent"("patientId");
CREATE INDEX "AuditEvent_encounterId_idx" ON "AuditEvent"("encounterId");
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
INSERT INTO "new_ImagingStudy" ("accessionNumber", "allergyScreened", "arrivedAt", "bodyRegion", "cancelledReason", "contrastGiven", "contrastRequired", "createdAt", "encounterId", "facilityId", "id", "imagingOrderId", "implantScreened", "modality", "mriSafetyScreened", "notes", "patientId", "performedAt", "performedByStaffId", "pregnancyScreened", "preparationCompleted", "resourceId", "scheduledAt", "scheduledEndAt", "startedAt", "status") SELECT "accessionNumber", "allergyScreened", "arrivedAt", "bodyRegion", "cancelledReason", "contrastGiven", "contrastRequired", "createdAt", "encounterId", "facilityId", "id", "imagingOrderId", "implantScreened", "modality", "mriSafetyScreened", "notes", "patientId", "performedAt", "performedByStaffId", "pregnancyScreened", "preparationCompleted", "resourceId", "scheduledAt", "scheduledAt" + 1800000, "startedAt", "status" FROM "ImagingStudy";
DROP TABLE "ImagingStudy";
ALTER TABLE "new_ImagingStudy" RENAME TO "ImagingStudy";
CREATE INDEX "ImagingStudy_imagingOrderId_idx" ON "ImagingStudy"("imagingOrderId");
CREATE INDEX "ImagingStudy_status_idx" ON "ImagingStudy"("status");
CREATE INDEX "ImagingStudy_resourceId_scheduledAt_idx" ON "ImagingStudy"("resourceId", "scheduledAt");
CREATE INDEX "ImagingStudy_facilityId_status_idx" ON "ImagingStudy"("facilityId", "status");
CREATE UNIQUE INDEX "ImagingStudy_facilityId_accessionNumber_key" ON "ImagingStudy"("facilityId", "accessionNumber");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
