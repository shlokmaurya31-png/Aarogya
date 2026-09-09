-- Phase B7 Advanced Diagnostics: LIS quality management + external lab + DICOM/
-- PACS boundary. Additive; mirrors prisma/migrations/20260909213421_phase_b7_
-- advanced_diagnostics. The Phase 4 Specimen/LabResult/ImagingStudy/
-- ImagingReport lifecycles are reused, not rebuilt — this only adds
-- documentary QC/calibration + external-lab records, specimen barcode/container
-- columns, radiology DICOM/PACS metadata columns, and resource metadata. No
-- destructive rewrite; no clinical-interpretation logic.

-- CreateEnum
CREATE TYPE "LabQcReviewStatus" AS ENUM ('PENDING', 'REVIEWED', 'REJECTED');
CREATE TYPE "ExternalLabStatus" AS ENUM ('DRAFT', 'SENT', 'RESULT_RECEIVED', 'REVIEWED', 'CANCELLED');

-- AlterTable (specimen identity — additive)
ALTER TABLE "Specimen" ADD COLUMN "barcode" TEXT;
ALTER TABLE "Specimen" ADD COLUMN "containerType" TEXT;

-- AlterTable (radiology DICOM/PACS boundary — additive)
ALTER TABLE "ImagingStudy" ADD COLUMN "studyInstanceUid" TEXT;
ALTER TABLE "ImagingStudy" ADD COLUMN "seriesUid" TEXT;
ALTER TABLE "ImagingStudy" ADD COLUMN "numberOfImages" INTEGER;
ALTER TABLE "ImagingStudy" ADD COLUMN "pacsReference" TEXT;
ALTER TABLE "ImagingStudy" ADD COLUMN "imageAvailability" TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE "ImagingStudy" ADD COLUMN "acquisitionAt" TIMESTAMP(3);
ALTER TABLE "ImagingStudy" ADD COLUMN "technicalNotes" TEXT;
ALTER TABLE "ImagingStudy" ADD COLUMN "dicomMetadata" JSONB;

-- AlterTable (imaging-resource metadata — additive)
ALTER TABLE "ImagingResource" ADD COLUMN "roomLabel" TEXT;
ALTER TABLE "ImagingResource" ADD COLUMN "location" TEXT;
ALTER TABLE "ImagingResource" ADD COLUMN "capabilities" JSONB;

-- CreateTable
CREATE TABLE "LabQcRecord" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "catalogTestId" TEXT,
    "instrumentId" TEXT NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "controlType" TEXT NOT NULL,
    "controlLot" TEXT,
    "observedValue" DOUBLE PRECISION,
    "expectedValue" DOUBLE PRECISION,
    "unit" TEXT,
    "result" TEXT,
    "status" "LabQcReviewStatus" NOT NULL DEFAULT 'PENDING',
    "performedByStaffId" TEXT NOT NULL,
    "reviewedByStaffId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LabQcRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LabCalibrationRecord" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "calibrationType" TEXT NOT NULL,
    "calibratedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "LabQcReviewStatus" NOT NULL DEFAULT 'PENDING',
    "performedByStaffId" TEXT NOT NULL,
    "reviewedByStaffId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "nextDueAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LabCalibrationRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ExternalLabReferral" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "labOrderId" TEXT,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT,
    "externalLabName" TEXT NOT NULL,
    "externalAccession" TEXT,
    "testDescription" TEXT,
    "status" "ExternalLabStatus" NOT NULL DEFAULT 'DRAFT',
    "sentByStaffId" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "resultReceivedAt" TIMESTAMP(3),
    "resultDocumentRef" TEXT,
    "reviewedByStaffId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ExternalLabReferral_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LabQcRecord_facilityId_status_idx" ON "LabQcRecord"("facilityId", "status");
CREATE INDEX "LabQcRecord_instrumentId_idx" ON "LabQcRecord"("instrumentId");
CREATE INDEX "LabCalibrationRecord_facilityId_status_idx" ON "LabCalibrationRecord"("facilityId", "status");
CREATE INDEX "LabCalibrationRecord_instrumentId_idx" ON "LabCalibrationRecord"("instrumentId");
CREATE INDEX "ExternalLabReferral_facilityId_status_idx" ON "ExternalLabReferral"("facilityId", "status");
CREATE INDEX "ExternalLabReferral_patientId_idx" ON "ExternalLabReferral"("patientId");
CREATE INDEX "ExternalLabReferral_labOrderId_idx" ON "ExternalLabReferral"("labOrderId");
