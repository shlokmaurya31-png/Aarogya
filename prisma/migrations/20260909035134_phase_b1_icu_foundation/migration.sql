-- CreateTable
CREATE TABLE "IcuUnit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "departmentId" TEXT,
    "name" TEXT NOT NULL,
    "icuType" TEXT NOT NULL DEFAULT 'GENERAL_ICU',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "ventilatorCapable" BOOLEAN NOT NULL DEFAULT false,
    "isolationCapable" BOOLEAN NOT NULL DEFAULT false,
    "bedCapacity" INTEGER,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "IcuUnit_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "IcuObservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "values" JSONB NOT NULL,
    "recordedByStaffId" TEXT NOT NULL,
    "recordedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IcuObservation_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "IcuObservation_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "IcuObservation_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "IcuDevice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "deviceType" TEXT NOT NULL,
    "site" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "insertedAt" DATETIME,
    "removedAt" DATETIME,
    "notes" TEXT,
    "recordedByStaffId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "IcuDevice_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "IcuDevice_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "IcuDevice_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "IcuInfusion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "medicationOrderId" TEXT,
    "drugName" TEXT NOT NULL,
    "route" TEXT,
    "concentration" TEXT,
    "rate" REAL,
    "rateUnit" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stoppedAt" DATETIME,
    "prescriberStaffId" TEXT,
    "recordedByStaffId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "IcuInfusion_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "IcuInfusion_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "IcuInfusion_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Bed" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "label" TEXT NOT NULL,
    "wardId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "genderRestriction" TEXT,
    "isolationRequired" BOOLEAN NOT NULL DEFAULT false,
    "icuCapable" BOOLEAN NOT NULL DEFAULT false,
    "ventilatorCapable" BOOLEAN NOT NULL DEFAULT false,
    "negativePressure" BOOLEAN NOT NULL DEFAULT false,
    "icuUnitId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Bed_wardId_fkey" FOREIGN KEY ("wardId") REFERENCES "Ward" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Bed_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Bed_icuUnitId_fkey" FOREIGN KEY ("icuUnitId") REFERENCES "IcuUnit" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Bed" ("createdAt", "facilityId", "genderRestriction", "id", "isolationRequired", "label", "status", "updatedAt", "wardId") SELECT "createdAt", "facilityId", "genderRestriction", "id", "isolationRequired", "label", "status", "updatedAt", "wardId" FROM "Bed";
DROP TABLE "Bed";
ALTER TABLE "new_Bed" RENAME TO "Bed";
CREATE INDEX "Bed_status_idx" ON "Bed"("status");
CREATE UNIQUE INDEX "Bed_facilityId_label_key" ON "Bed"("facilityId", "label");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "IcuUnit_facilityId_idx" ON "IcuUnit"("facilityId");

-- CreateIndex
CREATE UNIQUE INDEX "IcuUnit_facilityId_name_key" ON "IcuUnit"("facilityId", "name");

-- CreateIndex
CREATE INDEX "IcuObservation_encounterId_type_idx" ON "IcuObservation"("encounterId", "type");

-- CreateIndex
CREATE INDEX "IcuObservation_facilityId_idx" ON "IcuObservation"("facilityId");

-- CreateIndex
CREATE INDEX "IcuObservation_patientId_idx" ON "IcuObservation"("patientId");

-- CreateIndex
CREATE INDEX "IcuDevice_encounterId_idx" ON "IcuDevice"("encounterId");

-- CreateIndex
CREATE INDEX "IcuDevice_facilityId_idx" ON "IcuDevice"("facilityId");

-- CreateIndex
CREATE INDEX "IcuDevice_patientId_idx" ON "IcuDevice"("patientId");

-- CreateIndex
CREATE INDEX "IcuDevice_status_idx" ON "IcuDevice"("status");

-- CreateIndex
CREATE INDEX "IcuInfusion_encounterId_idx" ON "IcuInfusion"("encounterId");

-- CreateIndex
CREATE INDEX "IcuInfusion_facilityId_idx" ON "IcuInfusion"("facilityId");

-- CreateIndex
CREATE INDEX "IcuInfusion_patientId_idx" ON "IcuInfusion"("patientId");

-- CreateIndex
CREATE INDEX "IcuInfusion_status_idx" ON "IcuInfusion"("status");
