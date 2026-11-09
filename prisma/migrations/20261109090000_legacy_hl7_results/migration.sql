-- Flagship 5: legacy import phase 2 (HL7 v2 ADT and ORU). Additive: a new
-- record kind and a new table for imported results, kept apart from the
-- live LabResult (never in a verification queue, an alert or a release).

-- AlterEnum
ALTER TYPE "LegacyRecordKind" ADD VALUE 'RESULT';

-- CreateTable
CREATE TABLE "LegacyLabResult" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT,
    "batchId" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "testCode" TEXT NOT NULL,
    "testName" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "numericValue" DOUBLE PRECISION,
    "unit" TEXT,
    "originalValue" TEXT,
    "originalUnit" TEXT,
    "referenceRange" TEXT,
    "abnormalFlag" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegacyLabResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LegacyLabResult_patientId_testName_observedAt_idx" ON "LegacyLabResult"("patientId", "testName", "observedAt");

-- CreateIndex
CREATE INDEX "LegacyLabResult_batchId_idx" ON "LegacyLabResult"("batchId");

-- CreateIndex
CREATE INDEX "LegacyLabResult_facilityId_idx" ON "LegacyLabResult"("facilityId");

