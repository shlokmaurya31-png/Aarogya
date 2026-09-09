-- CreateTable
CREATE TABLE "Procedure" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "specialty" TEXT,
    "typicalDurationMinutes" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Procedure_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OperatingTheatre" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "departmentId" TEXT,
    "name" TEXT NOT NULL,
    "type" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "capabilities" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OperatingTheatre_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Surgery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "procedureId" TEXT,
    "procedureName" TEXT NOT NULL,
    "indication" TEXT,
    "laterality" TEXT,
    "urgency" TEXT NOT NULL DEFAULT 'ELECTIVE',
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "requestedByStaffId" TEXT NOT NULL,
    "requestedDate" DATETIME,
    "reviewedByStaffId" TEXT,
    "reviewedAt" DATETIME,
    "approvedByStaffId" TEXT,
    "approvedAt" DATETIME,
    "cancelledReason" TEXT,
    "cancelledAt" DATETIME,
    "consentStatus" TEXT,
    "consentAt" DATETIME,
    "consentByStaffId" TEXT,
    "consentDocumentId" TEXT,
    "preOpReady" BOOLEAN NOT NULL DEFAULT false,
    "preOpNotes" TEXT,
    "actualStart" DATETIME,
    "actualEnd" DATETIME,
    "surgeonStaffId" TEXT,
    "operativeFindings" TEXT,
    "operativeDetails" TEXT,
    "complications" TEXT,
    "estimatedBloodLossMl" INTEGER,
    "recoveryDestination" TEXT,
    "operativeNoteId" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Surgery_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Surgery_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Surgery_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Surgery_procedureId_fkey" FOREIGN KEY ("procedureId") REFERENCES "Procedure" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SurgerySchedule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "surgeryId" TEXT NOT NULL,
    "operatingTheatreId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "startAt" DATETIME NOT NULL,
    "endAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "schedulerStaffId" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SurgerySchedule_surgeryId_fkey" FOREIGN KEY ("surgeryId") REFERENCES "Surgery" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SurgerySchedule_operatingTheatreId_fkey" FOREIGN KEY ("operatingTheatreId") REFERENCES "OperatingTheatre" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SurgeryTeamMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "surgeryId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SurgeryTeamMember_surgeryId_fkey" FOREIGN KEY ("surgeryId") REFERENCES "Surgery" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SurgeryChecklistItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "surgeryId" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "checked" BOOLEAN NOT NULL DEFAULT false,
    "checkedByStaffId" TEXT,
    "checkedAt" DATETIME,
    CONSTRAINT "SurgeryChecklistItem_surgeryId_fkey" FOREIGN KEY ("surgeryId") REFERENCES "Surgery" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AnesthesiaRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "surgeryId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "anesthetistStaffId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "startAt" DATETIME,
    "endAt" DATETIME,
    "preAssessmentNoteId" TEXT,
    "intraOpNotes" TEXT,
    "complications" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AnesthesiaRecord_surgeryId_fkey" FOREIGN KEY ("surgeryId") REFERENCES "Surgery" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SurgicalSpecimen" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "surgeryId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "specimenType" TEXT NOT NULL,
    "site" TEXT,
    "label" TEXT,
    "destinationLab" TEXT,
    "status" TEXT NOT NULL DEFAULT 'COLLECTED',
    "collectedByStaffId" TEXT NOT NULL,
    "collectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    CONSTRAINT "SurgicalSpecimen_surgeryId_fkey" FOREIGN KEY ("surgeryId") REFERENCES "Surgery" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SurgeryItemUsage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "surgeryId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "usageType" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "itemLotId" TEXT,
    "manufacturer" TEXT,
    "serialNumber" TEXT,
    "site" TEXT,
    "quantity" REAL NOT NULL,
    "stockConsumed" BOOLEAN NOT NULL DEFAULT false,
    "implantedAt" DATETIME,
    "recordedByStaffId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SurgeryItemUsage_surgeryId_fkey" FOREIGN KEY ("surgeryId") REFERENCES "Surgery" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RecoveryRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "surgeryId" TEXT NOT NULL,
    "destination" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "arrivalAt" DATETIME,
    "departureAt" DATETIME,
    "responsibleStaffId" TEXT,
    "nurseStaffId" TEXT,
    "handoffId" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RecoveryRecord_surgeryId_fkey" FOREIGN KEY ("surgeryId") REFERENCES "Surgery" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Procedure_facilityId_idx" ON "Procedure"("facilityId");

-- CreateIndex
CREATE UNIQUE INDEX "Procedure_facilityId_code_key" ON "Procedure"("facilityId", "code");

-- CreateIndex
CREATE INDEX "OperatingTheatre_facilityId_idx" ON "OperatingTheatre"("facilityId");

-- CreateIndex
CREATE UNIQUE INDEX "OperatingTheatre_facilityId_name_key" ON "OperatingTheatre"("facilityId", "name");

-- CreateIndex
CREATE INDEX "Surgery_facilityId_idx" ON "Surgery"("facilityId");

-- CreateIndex
CREATE INDEX "Surgery_patientId_idx" ON "Surgery"("patientId");

-- CreateIndex
CREATE INDEX "Surgery_encounterId_idx" ON "Surgery"("encounterId");

-- CreateIndex
CREATE INDEX "Surgery_status_idx" ON "Surgery"("status");

-- CreateIndex
CREATE UNIQUE INDEX "SurgerySchedule_surgeryId_key" ON "SurgerySchedule"("surgeryId");

-- CreateIndex
CREATE INDEX "SurgerySchedule_operatingTheatreId_startAt_idx" ON "SurgerySchedule"("operatingTheatreId", "startAt");

-- CreateIndex
CREATE INDEX "SurgerySchedule_facilityId_idx" ON "SurgerySchedule"("facilityId");

-- CreateIndex
CREATE INDEX "SurgeryTeamMember_surgeryId_idx" ON "SurgeryTeamMember"("surgeryId");

-- CreateIndex
CREATE UNIQUE INDEX "SurgeryTeamMember_surgeryId_staffId_role_key" ON "SurgeryTeamMember"("surgeryId", "staffId", "role");

-- CreateIndex
CREATE INDEX "SurgeryChecklistItem_surgeryId_phase_idx" ON "SurgeryChecklistItem"("surgeryId", "phase");

-- CreateIndex
CREATE UNIQUE INDEX "SurgeryChecklistItem_surgeryId_itemKey_key" ON "SurgeryChecklistItem"("surgeryId", "itemKey");

-- CreateIndex
CREATE UNIQUE INDEX "AnesthesiaRecord_surgeryId_key" ON "AnesthesiaRecord"("surgeryId");

-- CreateIndex
CREATE INDEX "SurgicalSpecimen_surgeryId_idx" ON "SurgicalSpecimen"("surgeryId");

-- CreateIndex
CREATE INDEX "SurgicalSpecimen_patientId_idx" ON "SurgicalSpecimen"("patientId");

-- CreateIndex
CREATE INDEX "SurgeryItemUsage_surgeryId_idx" ON "SurgeryItemUsage"("surgeryId");

-- CreateIndex
CREATE INDEX "SurgeryItemUsage_patientId_idx" ON "SurgeryItemUsage"("patientId");

-- CreateIndex
CREATE INDEX "SurgeryItemUsage_itemId_idx" ON "SurgeryItemUsage"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryRecord_surgeryId_key" ON "RecoveryRecord"("surgeryId");
