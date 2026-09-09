-- Phase B3 Operating Theatre & Surgical Workflow. Additive; mirrors
-- prisma/migrations/20260909045456_phase_b3_operating_theatre. Composes
-- canonical Patient/Encounter/Item-stock/ClinicalNote — no parallel domain
-- models. Includes the surgery_schedule_no_overlap EXCLUDE constraint (the
-- race-proof OT double-booking guarantee), same convention as
-- imaging_resource_no_overlap.

-- CreateEnum
CREATE TYPE "SurgeryStatus" AS ENUM ('REQUESTED', 'REVIEWED', 'APPROVED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');
CREATE TYPE "AnesthesiaType" AS ENUM ('GENERAL', 'REGIONAL', 'LOCAL', 'SEDATION', 'OTHER');

-- CreateTable
CREATE TABLE "Procedure" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "specialty" TEXT,
    "typicalDurationMinutes" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Procedure_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OperatingTheatre" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "departmentId" TEXT,
    "name" TEXT NOT NULL,
    "type" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "capabilities" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OperatingTheatre_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Surgery" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "procedureId" TEXT,
    "procedureName" TEXT NOT NULL,
    "indication" TEXT,
    "laterality" TEXT,
    "urgency" TEXT NOT NULL DEFAULT 'ELECTIVE',
    "status" "SurgeryStatus" NOT NULL DEFAULT 'REQUESTED',
    "requestedByStaffId" TEXT NOT NULL,
    "requestedDate" TIMESTAMP(3),
    "reviewedByStaffId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "approvedByStaffId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "cancelledReason" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "consentStatus" TEXT,
    "consentAt" TIMESTAMP(3),
    "consentByStaffId" TEXT,
    "consentDocumentId" TEXT,
    "preOpReady" BOOLEAN NOT NULL DEFAULT false,
    "preOpNotes" TEXT,
    "actualStart" TIMESTAMP(3),
    "actualEnd" TIMESTAMP(3),
    "surgeonStaffId" TEXT,
    "operativeFindings" TEXT,
    "operativeDetails" TEXT,
    "complications" TEXT,
    "estimatedBloodLossMl" INTEGER,
    "recoveryDestination" TEXT,
    "operativeNoteId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Surgery_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SurgerySchedule" (
    "id" TEXT NOT NULL,
    "surgeryId" TEXT NOT NULL,
    "operatingTheatreId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "schedulerStaffId" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SurgerySchedule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SurgeryTeamMember" (
    "id" TEXT NOT NULL,
    "surgeryId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SurgeryTeamMember_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SurgeryChecklistItem" (
    "id" TEXT NOT NULL,
    "surgeryId" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "checked" BOOLEAN NOT NULL DEFAULT false,
    "checkedByStaffId" TEXT,
    "checkedAt" TIMESTAMP(3),
    CONSTRAINT "SurgeryChecklistItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AnesthesiaRecord" (
    "id" TEXT NOT NULL,
    "surgeryId" TEXT NOT NULL,
    "type" "AnesthesiaType" NOT NULL,
    "anesthetistStaffId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "preAssessmentNoteId" TEXT,
    "intraOpNotes" TEXT,
    "complications" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AnesthesiaRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SurgicalSpecimen" (
    "id" TEXT NOT NULL,
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
    "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    CONSTRAINT "SurgicalSpecimen_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SurgeryItemUsage" (
    "id" TEXT NOT NULL,
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
    "quantity" DOUBLE PRECISION NOT NULL,
    "stockConsumed" BOOLEAN NOT NULL DEFAULT false,
    "implantedAt" TIMESTAMP(3),
    "recordedByStaffId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SurgeryItemUsage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RecoveryRecord" (
    "id" TEXT NOT NULL,
    "surgeryId" TEXT NOT NULL,
    "destination" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "arrivalAt" TIMESTAMP(3),
    "departureAt" TIMESTAMP(3),
    "responsibleStaffId" TEXT,
    "nurseStaffId" TEXT,
    "handoffId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RecoveryRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Procedure_facilityId_idx" ON "Procedure"("facilityId");
CREATE UNIQUE INDEX "Procedure_facilityId_code_key" ON "Procedure"("facilityId", "code");
CREATE INDEX "OperatingTheatre_facilityId_idx" ON "OperatingTheatre"("facilityId");
CREATE UNIQUE INDEX "OperatingTheatre_facilityId_name_key" ON "OperatingTheatre"("facilityId", "name");
CREATE INDEX "Surgery_facilityId_idx" ON "Surgery"("facilityId");
CREATE INDEX "Surgery_patientId_idx" ON "Surgery"("patientId");
CREATE INDEX "Surgery_encounterId_idx" ON "Surgery"("encounterId");
CREATE INDEX "Surgery_status_idx" ON "Surgery"("status");
CREATE UNIQUE INDEX "SurgerySchedule_surgeryId_key" ON "SurgerySchedule"("surgeryId");
CREATE INDEX "SurgerySchedule_operatingTheatreId_startAt_idx" ON "SurgerySchedule"("operatingTheatreId", "startAt");
CREATE INDEX "SurgerySchedule_facilityId_idx" ON "SurgerySchedule"("facilityId");
CREATE INDEX "SurgeryTeamMember_surgeryId_idx" ON "SurgeryTeamMember"("surgeryId");
CREATE UNIQUE INDEX "SurgeryTeamMember_surgeryId_staffId_role_key" ON "SurgeryTeamMember"("surgeryId", "staffId", "role");
CREATE INDEX "SurgeryChecklistItem_surgeryId_phase_idx" ON "SurgeryChecklistItem"("surgeryId", "phase");
CREATE UNIQUE INDEX "SurgeryChecklistItem_surgeryId_itemKey_key" ON "SurgeryChecklistItem"("surgeryId", "itemKey");
CREATE UNIQUE INDEX "AnesthesiaRecord_surgeryId_key" ON "AnesthesiaRecord"("surgeryId");
CREATE INDEX "SurgicalSpecimen_surgeryId_idx" ON "SurgicalSpecimen"("surgeryId");
CREATE INDEX "SurgicalSpecimen_patientId_idx" ON "SurgicalSpecimen"("patientId");
CREATE INDEX "SurgeryItemUsage_surgeryId_idx" ON "SurgeryItemUsage"("surgeryId");
CREATE INDEX "SurgeryItemUsage_patientId_idx" ON "SurgeryItemUsage"("patientId");
CREATE INDEX "SurgeryItemUsage_itemId_idx" ON "SurgeryItemUsage"("itemId");
CREATE UNIQUE INDEX "RecoveryRecord_surgeryId_key" ON "RecoveryRecord"("surgeryId");

-- AddForeignKey
ALTER TABLE "Procedure" ADD CONSTRAINT "Procedure_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OperatingTheatre" ADD CONSTRAINT "OperatingTheatre_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Surgery" ADD CONSTRAINT "Surgery_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Surgery" ADD CONSTRAINT "Surgery_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Surgery" ADD CONSTRAINT "Surgery_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Surgery" ADD CONSTRAINT "Surgery_procedureId_fkey" FOREIGN KEY ("procedureId") REFERENCES "Procedure"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SurgerySchedule" ADD CONSTRAINT "SurgerySchedule_surgeryId_fkey" FOREIGN KEY ("surgeryId") REFERENCES "Surgery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SurgerySchedule" ADD CONSTRAINT "SurgerySchedule_operatingTheatreId_fkey" FOREIGN KEY ("operatingTheatreId") REFERENCES "OperatingTheatre"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SurgeryTeamMember" ADD CONSTRAINT "SurgeryTeamMember_surgeryId_fkey" FOREIGN KEY ("surgeryId") REFERENCES "Surgery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SurgeryChecklistItem" ADD CONSTRAINT "SurgeryChecklistItem_surgeryId_fkey" FOREIGN KEY ("surgeryId") REFERENCES "Surgery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AnesthesiaRecord" ADD CONSTRAINT "AnesthesiaRecord_surgeryId_fkey" FOREIGN KEY ("surgeryId") REFERENCES "Surgery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SurgicalSpecimen" ADD CONSTRAINT "SurgicalSpecimen_surgeryId_fkey" FOREIGN KEY ("surgeryId") REFERENCES "Surgery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SurgeryItemUsage" ADD CONSTRAINT "SurgeryItemUsage_surgeryId_fkey" FOREIGN KEY ("surgeryId") REFERENCES "Surgery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RecoveryRecord" ADD CONSTRAINT "RecoveryRecord_surgeryId_fkey" FOREIGN KEY ("surgeryId") REFERENCES "Surgery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Race-proof OT double-booking guarantee (Prisma DSL cannot express EXCLUDE).
-- Half-open [startAt, endAt) so adjacent slots are allowed; only SCHEDULED
-- rows reserve the theatre (CANCELLED frees it).
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "SurgerySchedule" ADD CONSTRAINT "surgery_schedule_no_overlap"
  EXCLUDE USING gist (
    "operatingTheatreId" WITH =,
    tsrange("startAt", "endAt", '[)') WITH &&
  )
  WHERE ("status" = 'SCHEDULED');
