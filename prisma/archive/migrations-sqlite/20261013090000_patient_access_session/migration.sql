-- Patient-consented access sessions (SQLite).
--
-- Strictly additive: one new table (PatientAccessSession). The model was added
-- to schema.prisma in 1c098a4 without a migration (local dev DBs got it via
-- `prisma db push`); this backfills it.

-- CreateTable
CREATE TABLE "PatientAccessSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "patientId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "codeHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "purpose" TEXT,
    "doctorUserId" TEXT,
    "doctorStaffId" TEXT,
    "doctorName" TEXT,
    "facilityId" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "activeExpiresAt" DATETIME,
    "extensionCount" INTEGER NOT NULL DEFAULT 0,
    "redeemedAt" DATETIME,
    "endedAt" DATETIME,
    "endedBy" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "PatientAccessSession_codeHash_key" ON "PatientAccessSession"("codeHash");

-- CreateIndex
CREATE INDEX "PatientAccessSession_patientId_status_idx" ON "PatientAccessSession"("patientId", "status");

-- CreateIndex
CREATE INDEX "PatientAccessSession_doctorUserId_status_idx" ON "PatientAccessSession"("doctorUserId", "status");

-- CreateIndex
CREATE INDEX "PatientAccessSession_status_expiresAt_idx" ON "PatientAccessSession"("status", "expiresAt");

