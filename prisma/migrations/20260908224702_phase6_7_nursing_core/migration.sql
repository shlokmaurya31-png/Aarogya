-- CreateTable
CREATE TABLE "NursingAssessment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "nurseStaffId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "previousVersionId" TEXT,
    "findings" JSONB NOT NULL,
    "completedAt" DATETIME,
    "signedAt" DATETIME,
    "amendedAt" DATETIME,
    "amendmentReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NursingAssessment_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "NursingAssessment_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "NursingAssessment_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "NursingAssessment_nurseStaffId_fkey" FOREIGN KEY ("nurseStaffId") REFERENCES "HospitalStaffProfile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_CarePlanIntervention" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "carePlanId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "responsibleRole" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "taskId" TEXT,
    CONSTRAINT "CarePlanIntervention_carePlanId_fkey" FOREIGN KEY ("carePlanId") REFERENCES "CarePlan" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CarePlanIntervention_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_CarePlanIntervention" ("carePlanId", "completedAt", "createdAt", "description", "id", "responsibleRole", "status") SELECT "carePlanId", "completedAt", "createdAt", "description", "id", "responsibleRole", "status" FROM "CarePlanIntervention";
DROP TABLE "CarePlanIntervention";
ALTER TABLE "new_CarePlanIntervention" RENAME TO "CarePlanIntervention";
CREATE INDEX "CarePlanIntervention_carePlanId_idx" ON "CarePlanIntervention"("carePlanId");
CREATE INDEX "CarePlanIntervention_taskId_idx" ON "CarePlanIntervention"("taskId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "NursingAssessment_facilityId_idx" ON "NursingAssessment"("facilityId");

-- CreateIndex
CREATE INDEX "NursingAssessment_patientId_idx" ON "NursingAssessment"("patientId");

-- CreateIndex
CREATE INDEX "NursingAssessment_encounterId_isCurrent_idx" ON "NursingAssessment"("encounterId", "isCurrent");

-- Phase 6.7: at most one open (endAt IS NULL) NursingAssignment per patient.
-- Not expressible in schema.prisma; hand-written here and mirrored in
-- prisma/migrations-postgres-baseline, matching the existing convention
-- for the Payer/Tariff exclusion constraints.
CREATE UNIQUE INDEX "NursingAssignment_patientId_open_key" ON "NursingAssignment"("patientId") WHERE "endAt" IS NULL;
