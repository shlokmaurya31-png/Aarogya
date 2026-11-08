-- Flagship 4b: the charge nurse's conflict queue. Additive: a new enum and
-- nullable columns; existing conflicts stay OPEN with no resolution.

-- CreateEnum
CREATE TYPE "OfflineConflictResolution" AS ENUM ('NO_HARM_FOUND', 'INCIDENT_RAISED', 'DUPLICATE_RECORD', 'RECORD_STANDS', 'RECORDED_ONLINE');

-- AlterTable
ALTER TABLE "DoseLease" ADD COLUMN     "overrideConfirmReason" TEXT,
ADD COLUMN     "overrideConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "overrideConfirmedByUserId" TEXT;

-- AlterTable
ALTER TABLE "OfflineConflict" ADD COLUMN     "escalatedAt" TIMESTAMP(3),
ADD COLUMN     "resolution" "OfflineConflictResolution",
ADD COLUMN     "resolutionReason" TEXT;

-- A resolved conflict names who, when, how and why.
ALTER TABLE "OfflineConflict" ADD CONSTRAINT "OfflineConflict_resolved"
  CHECK ("status" = 'OPEN' OR ("resolvedAt" IS NOT NULL AND "resolvedByUserId" IS NOT NULL AND "resolution" IS NOT NULL AND "resolutionReason" IS NOT NULL));

-- CreateIndex
CREATE INDEX "OfflineConflict_status_severity_createdAt_idx" ON "OfflineConflict"("status", "severity", "createdAt");
