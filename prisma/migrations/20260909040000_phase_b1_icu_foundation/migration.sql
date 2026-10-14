-- Phase B1 ICU Foundation. Additive only: ICU-capability columns on the
-- existing Bed (the canonical bed is not replaced), plus IcuUnit /
-- IcuObservation / IcuDevice / IcuInfusion referencing canonical Facility/
-- Patient/Encounter records. Mirrors prisma/migrations/
-- 20260909035134_phase_b1_icu_foundation (the SQLite dev migration, which
-- rebuilds Bed because SQLite lacks straightforward multi-column ADD;
-- Postgres adds the columns in place — identical resulting shape).

-- CreateEnum
CREATE TYPE "IcuType" AS ENUM ('MICU', 'SICU', 'CCU', 'NICU', 'PICU', 'HDU', 'GENERAL_ICU');

-- AlterTable (additive Bed capabilities)
ALTER TABLE "Bed" ADD COLUMN "icuCapable" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Bed" ADD COLUMN "ventilatorCapable" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Bed" ADD COLUMN "negativePressure" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Bed" ADD COLUMN "icuUnitId" TEXT;

-- CreateTable
CREATE TABLE "IcuUnit" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "departmentId" TEXT,
    "name" TEXT NOT NULL,
    "icuType" "IcuType" NOT NULL DEFAULT 'GENERAL_ICU',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "ventilatorCapable" BOOLEAN NOT NULL DEFAULT false,
    "isolationCapable" BOOLEAN NOT NULL DEFAULT false,
    "bedCapacity" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IcuUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IcuObservation" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "values" JSONB NOT NULL,
    "recordedByStaffId" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IcuObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IcuDevice" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "deviceType" TEXT NOT NULL,
    "site" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "insertedAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),
    "notes" TEXT,
    "recordedByStaffId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IcuDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IcuInfusion" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "medicationOrderId" TEXT,
    "drugName" TEXT NOT NULL,
    "route" TEXT,
    "concentration" TEXT,
    "rate" DOUBLE PRECISION,
    "rateUnit" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stoppedAt" TIMESTAMP(3),
    "prescriberStaffId" TEXT,
    "recordedByStaffId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IcuInfusion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IcuUnit_facilityId_name_key" ON "IcuUnit"("facilityId", "name");
CREATE INDEX "IcuUnit_facilityId_idx" ON "IcuUnit"("facilityId");
CREATE INDEX "IcuObservation_encounterId_type_idx" ON "IcuObservation"("encounterId", "type");
CREATE INDEX "IcuObservation_facilityId_idx" ON "IcuObservation"("facilityId");
CREATE INDEX "IcuObservation_patientId_idx" ON "IcuObservation"("patientId");
CREATE INDEX "IcuDevice_encounterId_idx" ON "IcuDevice"("encounterId");
CREATE INDEX "IcuDevice_facilityId_idx" ON "IcuDevice"("facilityId");
CREATE INDEX "IcuDevice_patientId_idx" ON "IcuDevice"("patientId");
CREATE INDEX "IcuDevice_status_idx" ON "IcuDevice"("status");
CREATE INDEX "IcuInfusion_encounterId_idx" ON "IcuInfusion"("encounterId");
CREATE INDEX "IcuInfusion_facilityId_idx" ON "IcuInfusion"("facilityId");
CREATE INDEX "IcuInfusion_patientId_idx" ON "IcuInfusion"("patientId");
CREATE INDEX "IcuInfusion_status_idx" ON "IcuInfusion"("status");
CREATE INDEX "Bed_icuUnitId_idx" ON "Bed"("icuUnitId");

-- AddForeignKey
ALTER TABLE "Bed" ADD CONSTRAINT "Bed_icuUnitId_fkey" FOREIGN KEY ("icuUnitId") REFERENCES "IcuUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "IcuUnit" ADD CONSTRAINT "IcuUnit_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IcuObservation" ADD CONSTRAINT "IcuObservation_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IcuObservation" ADD CONSTRAINT "IcuObservation_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IcuObservation" ADD CONSTRAINT "IcuObservation_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IcuDevice" ADD CONSTRAINT "IcuDevice_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IcuDevice" ADD CONSTRAINT "IcuDevice_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IcuDevice" ADD CONSTRAINT "IcuDevice_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IcuInfusion" ADD CONSTRAINT "IcuInfusion_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IcuInfusion" ADD CONSTRAINT "IcuInfusion_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IcuInfusion" ADD CONSTRAINT "IcuInfusion_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
