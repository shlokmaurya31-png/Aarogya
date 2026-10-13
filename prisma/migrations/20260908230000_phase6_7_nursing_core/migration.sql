-- Phase 6.7 Nursing Core: NursingAssessment (versioned clinical documentation,
-- DRAFT -> COMPLETED -> SIGNED -> SUPERSEDED, mirrors ClinicalNote's shape),
-- CarePlanIntervention.taskId (optional link into the existing Task engine),
-- and a partial unique index enforcing "at most one open NursingAssignment
-- per patient" (assignNurse() already expressed this invariant in
-- application code; the index closes the concurrent-create race where two
-- simultaneous assignments could both end the same stale row and both
-- succeed). Mirrors prisma/migrations/20260908224702_phase6_7_nursing_core
-- (the SQLite dev migration) — same tables/columns, portable SQL.

-- CreateTable
CREATE TABLE "NursingAssessment" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "nurseStaffId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "previousVersionId" TEXT,
    "findings" JSONB NOT NULL,
    "completedAt" TIMESTAMP(3),
    "signedAt" TIMESTAMP(3),
    "amendedAt" TIMESTAMP(3),
    "amendmentReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NursingAssessment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NursingAssessment_facilityId_idx" ON "NursingAssessment"("facilityId");

-- CreateIndex
CREATE INDEX "NursingAssessment_patientId_idx" ON "NursingAssessment"("patientId");

-- CreateIndex
CREATE INDEX "NursingAssessment_encounterId_isCurrent_idx" ON "NursingAssessment"("encounterId", "isCurrent");

-- AddForeignKey
ALTER TABLE "NursingAssessment" ADD CONSTRAINT "NursingAssessment_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NursingAssessment" ADD CONSTRAINT "NursingAssessment_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NursingAssessment" ADD CONSTRAINT "NursingAssessment_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NursingAssessment" ADD CONSTRAINT "NursingAssessment_nurseStaffId_fkey" FOREIGN KEY ("nurseStaffId") REFERENCES "HospitalStaffProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "CarePlanIntervention" ADD COLUMN "taskId" TEXT;

-- CreateIndex
CREATE INDEX "CarePlanIntervention_taskId_idx" ON "CarePlanIntervention"("taskId");

-- AddForeignKey
ALTER TABLE "CarePlanIntervention" ADD CONSTRAINT "CarePlanIntervention_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Partial unique index: at most one open (endAt IS NULL) NursingAssignment
-- per patient. Not expressible in schema.prisma; hand-written here, same
-- convention as the imaging_resource_no_overlap / tariff_no_overlap
-- exclusion constraints.
CREATE UNIQUE INDEX "NursingAssignment_patientId_open_key" ON "NursingAssignment"("patientId") WHERE "endAt" IS NULL;
