-- Flagship 3d: legacy import, the review queue and chunked, resumable runs.
-- Additive: a new enum value, three nullable or defaulted columns on
-- LegacyImportBatch (existing batches keep their status; chunksCommitted 0),
-- and a new table. No existing row is changed.

-- AlterEnum
ALTER TYPE "LegacyImportBatchStatus" ADD VALUE 'FAILED';

-- AlterTable
ALTER TABLE "LegacyImportBatch" ADD COLUMN "chunksCommitted" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "failedAt" TIMESTAMP(3),
ADD COLUMN "lastError" TEXT;

-- CreateEnum
CREATE TYPE "LegacyPatientReviewStatus" AS ENUM ('OPEN', 'ACCEPTED', 'KEPT');

-- CreateTable
CREATE TABLE "LegacyPatientReview" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "incoming" JSONB NOT NULL,
    "existing" JSONB NOT NULL,
    "differences" TEXT[],
    "incomingHash" TEXT NOT NULL,
    "status" "LegacyPatientReviewStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionReason" TEXT,

    CONSTRAINT "LegacyPatientReview_pkey" PRIMARY KEY ("id"),
    -- A decided review names who, when and why.
    CONSTRAINT "LegacyPatientReview_decided" CHECK ("status" = 'OPEN' OR ("decidedByUserId" IS NOT NULL AND "decidedAt" IS NOT NULL AND "decisionReason" IS NOT NULL))
);

-- CreateIndex
CREATE INDEX "LegacyPatientReview_facilityId_status_idx" ON "LegacyPatientReview"("facilityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "LegacyPatientReview_facilityId_sourceSystem_sourceKey_incom_key" ON "LegacyPatientReview"("facilityId", "sourceSystem", "sourceKey", "incomingHash");
