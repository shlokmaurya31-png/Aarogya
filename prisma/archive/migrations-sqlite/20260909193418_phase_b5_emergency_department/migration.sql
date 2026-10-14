-- CreateTable
CREATE TABLE "EdReassessment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "encounterId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "reassessedByStaffId" TEXT NOT NULL,
    "findings" TEXT,
    "vitalId" TEXT,
    "taskId" TEXT,
    "escalationRequired" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EdReassessment_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EdResuscitation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "encounterId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVATED',
    "reason" TEXT,
    "activatedByStaffId" TEXT NOT NULL,
    "activatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedByStaffId" TEXT,
    "closedAt" DATETIME,
    "notes" TEXT,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EdResuscitation_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EdDisposition" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "encounterId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "destinationDetail" TEXT,
    "reason" TEXT,
    "transferFacilityName" TEXT,
    "admissionId" TEXT,
    "handoffId" TEXT,
    "lastKnownLocation" TEXT,
    "dispositionedByStaffId" TEXT NOT NULL,
    "dispositionAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    CONSTRAINT "EdDisposition_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_TriageAssessment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "encounterId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "recordedByStaffId" TEXT NOT NULL,
    "acuity" INTEGER NOT NULL,
    "chiefComplaint" TEXT,
    "redFlags" TEXT,
    "assignedArea" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "amendsId" TEXT,
    "presentingSymptoms" TEXT,
    "allergySummary" TEXT,
    "currentMedications" TEXT,
    "relevantHistory" TEXT,
    "painScore" INTEGER,
    "mentalStatus" TEXT,
    "mobility" TEXT,
    "pregnancyStatus" TEXT,
    "isolationRequired" BOOLEAN NOT NULL DEFAULT false,
    "injuryTrauma" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "TriageAssessment_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TriageAssessment_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TriageAssessment_recordedByStaffId_fkey" FOREIGN KEY ("recordedByStaffId") REFERENCES "HospitalStaffProfile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TriageAssessment_amendsId_fkey" FOREIGN KEY ("amendsId") REFERENCES "TriageAssessment" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_TriageAssessment" ("acuity", "assignedArea", "chiefComplaint", "createdAt", "encounterId", "facilityId", "id", "notes", "recordedByStaffId", "redFlags") SELECT "acuity", "assignedArea", "chiefComplaint", "createdAt", "encounterId", "facilityId", "id", "notes", "recordedByStaffId", "redFlags" FROM "TriageAssessment";
DROP TABLE "TriageAssessment";
ALTER TABLE "new_TriageAssessment" RENAME TO "TriageAssessment";
CREATE INDEX "TriageAssessment_encounterId_idx" ON "TriageAssessment"("encounterId");
CREATE INDEX "TriageAssessment_facilityId_idx" ON "TriageAssessment"("facilityId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "EdReassessment_encounterId_idx" ON "EdReassessment"("encounterId");

-- CreateIndex
CREATE INDEX "EdReassessment_facilityId_idx" ON "EdReassessment"("facilityId");

-- CreateIndex
CREATE INDEX "EdReassessment_patientId_idx" ON "EdReassessment"("patientId");

-- CreateIndex
CREATE INDEX "EdResuscitation_encounterId_idx" ON "EdResuscitation"("encounterId");

-- CreateIndex
CREATE INDEX "EdResuscitation_facilityId_idx" ON "EdResuscitation"("facilityId");

-- CreateIndex
CREATE UNIQUE INDEX "EdDisposition_encounterId_key" ON "EdDisposition"("encounterId");

-- CreateIndex
CREATE INDEX "EdDisposition_facilityId_idx" ON "EdDisposition"("facilityId");

-- CreateIndex
CREATE INDEX "EdDisposition_patientId_idx" ON "EdDisposition"("patientId");

-- CreateIndex
CREATE INDEX "EdDisposition_type_idx" ON "EdDisposition"("type");

-- Phase B5 concurrency guards (partial unique indexes — not expressible in
-- schema.prisma, same hand-authored convention as the nursing "one open
-- assignment" index). These make the ED concurrency races single-winner:
--  * at most one open resuscitation workflow per encounter
--  * at most one active (unreleased) physical location per encounter
CREATE UNIQUE INDEX "ed_resuscitation_one_open_per_encounter" ON "EdResuscitation"("encounterId") WHERE "status" <> 'CLOSED';
CREATE UNIQUE INDEX "encounter_location_one_active_per_encounter" ON "EncounterLocation"("encounterId") WHERE "releasedAt" IS NULL;
