-- Phase B5 Emergency Department / Emergency Care Operating System. Additive;
-- mirrors prisma/migrations/20260909193418_phase_b5_emergency_department. An
-- ED visit stays a canonical Encounter (type=ED) — this only adds ED
-- reassessment, an explicit high-acuity/resuscitation workflow, and the
-- terminal ED disposition, plus documentary/lifecycle columns on the existing
-- TriageAssessment. No triage/severity/AI algorithm is encoded. Two partial
-- unique indexes make the ED concurrency races single-winner.

-- CreateEnum
CREATE TYPE "EdResuscitationStatus" AS ENUM ('ACTIVATED', 'ACTIVE', 'STABILIZED', 'HANDED_OVER', 'DISPOSITION_PENDING', 'CLOSED');
CREATE TYPE "EdDispositionType" AS ENUM ('DISCHARGE', 'ADMIT_WARD', 'ADMIT_ICU', 'TO_OT', 'TRANSFER_OUT', 'REFERRAL', 'LAMA', 'DAMA', 'LWBS', 'ABSCONDED', 'DECEASED');

-- AlterTable (additive columns on the existing TriageAssessment — Phase B5 ED triage lifecycle + documentary fields)
ALTER TABLE "TriageAssessment" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'COMPLETED';
ALTER TABLE "TriageAssessment" ADD COLUMN "amendsId" TEXT;
ALTER TABLE "TriageAssessment" ADD COLUMN "presentingSymptoms" TEXT;
ALTER TABLE "TriageAssessment" ADD COLUMN "allergySummary" TEXT;
ALTER TABLE "TriageAssessment" ADD COLUMN "currentMedications" TEXT;
ALTER TABLE "TriageAssessment" ADD COLUMN "relevantHistory" TEXT;
ALTER TABLE "TriageAssessment" ADD COLUMN "painScore" INTEGER;
ALTER TABLE "TriageAssessment" ADD COLUMN "mentalStatus" TEXT;
ALTER TABLE "TriageAssessment" ADD COLUMN "mobility" TEXT;
ALTER TABLE "TriageAssessment" ADD COLUMN "pregnancyStatus" TEXT;
ALTER TABLE "TriageAssessment" ADD COLUMN "isolationRequired" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "TriageAssessment" ADD COLUMN "injuryTrauma" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "EdReassessment" (
    "id" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "reassessedByStaffId" TEXT NOT NULL,
    "findings" TEXT,
    "vitalId" TEXT,
    "taskId" TEXT,
    "escalationRequired" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EdReassessment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EdResuscitation" (
    "id" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "status" "EdResuscitationStatus" NOT NULL DEFAULT 'ACTIVATED',
    "reason" TEXT,
    "activatedByStaffId" TEXT NOT NULL,
    "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedByStaffId" TEXT,
    "closedAt" TIMESTAMP(3),
    "notes" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EdResuscitation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EdDisposition" (
    "id" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "type" "EdDispositionType" NOT NULL,
    "destinationDetail" TEXT,
    "reason" TEXT,
    "transferFacilityName" TEXT,
    "admissionId" TEXT,
    "handoffId" TEXT,
    "lastKnownLocation" TEXT,
    "dispositionedByStaffId" TEXT NOT NULL,
    "dispositionAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    CONSTRAINT "EdDisposition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EdReassessment_encounterId_idx" ON "EdReassessment"("encounterId");
CREATE INDEX "EdReassessment_facilityId_idx" ON "EdReassessment"("facilityId");
CREATE INDEX "EdReassessment_patientId_idx" ON "EdReassessment"("patientId");
CREATE INDEX "EdResuscitation_encounterId_idx" ON "EdResuscitation"("encounterId");
CREATE INDEX "EdResuscitation_facilityId_idx" ON "EdResuscitation"("facilityId");
CREATE UNIQUE INDEX "EdDisposition_encounterId_key" ON "EdDisposition"("encounterId");
CREATE INDEX "EdDisposition_facilityId_idx" ON "EdDisposition"("facilityId");
CREATE INDEX "EdDisposition_patientId_idx" ON "EdDisposition"("patientId");
CREATE INDEX "EdDisposition_type_idx" ON "EdDisposition"("type");

-- AddForeignKey
ALTER TABLE "TriageAssessment" ADD CONSTRAINT "TriageAssessment_amendsId_fkey" FOREIGN KEY ("amendsId") REFERENCES "TriageAssessment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EdReassessment" ADD CONSTRAINT "EdReassessment_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EdResuscitation" ADD CONSTRAINT "EdResuscitation_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EdDisposition" ADD CONSTRAINT "EdDisposition_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Phase B5 concurrency guards (partial unique indexes — Prisma DSL cannot
-- express a filtered UNIQUE index; same hand-authored convention as the
-- nursing "one open assignment" index). Single-winner for the ED races:
--  * at most one open resuscitation workflow per encounter
--  * at most one active (unreleased) physical location per encounter
CREATE UNIQUE INDEX "ed_resuscitation_one_open_per_encounter" ON "EdResuscitation"("encounterId") WHERE "status" <> 'CLOSED';
CREATE UNIQUE INDEX "encounter_location_one_active_per_encounter" ON "EncounterLocation"("encounterId") WHERE "releasedAt" IS NULL;
