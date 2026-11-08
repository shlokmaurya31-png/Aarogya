-- Flagship 2, step 6: legacy import, phase 1 (docs/LEGACY_IMPORT_DESIGN.md §11).
-- Additive: two enums, two tables, two nullable columns. No existing row changes.

CREATE TYPE "LegacyImportBatchStatus" AS ENUM ('COMMITTING', 'COMMITTED');

CREATE TYPE "LegacyRecordKind" AS ENUM ('PATIENT', 'ENCOUNTER');

ALTER TABLE "Encounter" ADD COLUMN     "importBatchId" TEXT;

ALTER TABLE "Patient" ADD COLUMN     "importBatchId" TEXT;

CREATE TABLE "LegacyImportBatch" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "status" "LegacyImportBatchStatus" NOT NULL DEFAULT 'COMMITTING',
    "counts" JSONB NOT NULL,
    "startedByUserId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committedByUserId" TEXT,
    "committedAt" TIMESTAMP(3),

    CONSTRAINT "LegacyImportBatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LegacyRecordKey" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "kind" "LegacyRecordKind" NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "clinicianName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegacyRecordKey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LegacyImportBatch_facilityId_fileHash_key" ON "LegacyImportBatch"("facilityId", "fileHash");

CREATE INDEX "LegacyRecordKey_batchId_idx" ON "LegacyRecordKey"("batchId");

CREATE UNIQUE INDEX "LegacyRecordKey_facilityId_sourceSystem_kind_sourceKey_key" ON "LegacyRecordKey"("facilityId", "sourceSystem", "kind", "sourceKey");
