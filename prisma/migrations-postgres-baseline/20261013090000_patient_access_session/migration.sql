-- Patient-consented access sessions (PostgreSQL).
-- Mirrors prisma/migrations/20261013090000_patient_access_session.
--
-- Strictly additive: one new table (PatientAccessSession). The model was added
-- to schema.prisma in 1c098a4 without a migration; this backfills it.

-- CreateTable
CREATE TABLE "PatientAccessSession" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "codeHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "purpose" TEXT,
    "doctorUserId" TEXT,
    "doctorStaffId" TEXT,
    "doctorName" TEXT,
    "facilityId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "activeExpiresAt" TIMESTAMP(3),
    "extensionCount" INTEGER NOT NULL DEFAULT 0,
    "redeemedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "endedBy" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PatientAccessSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PatientAccessSession_codeHash_key" ON "PatientAccessSession"("codeHash");

-- CreateIndex
CREATE INDEX "PatientAccessSession_patientId_status_idx" ON "PatientAccessSession"("patientId", "status");

-- CreateIndex
CREATE INDEX "PatientAccessSession_doctorUserId_status_idx" ON "PatientAccessSession"("doctorUserId", "status");

-- CreateIndex
CREATE INDEX "PatientAccessSession_status_expiresAt_idx" ON "PatientAccessSession"("status", "expiresAt");
