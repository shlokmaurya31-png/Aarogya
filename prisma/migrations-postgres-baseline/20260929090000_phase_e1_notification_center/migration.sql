-- Phase E1 — Notification centre (PostgreSQL).
-- Mirrors prisma/migrations/20260929090000_phase_e1_notification_center.
--
-- Strictly additive: one new table (Notification). This was missing from the
-- Postgres baseline when the SQLite migration landed; added 2026-10-13.

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "recipientStaffId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'OPERATIONAL',
    "priority" TEXT NOT NULL DEFAULT 'ROUTINE',
    "title" TEXT NOT NULL,
    "body" TEXT,
    "linkHref" TEXT,
    "patientId" TEXT,
    "encounterId" TEXT,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "createdByStaffId" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notification_recipientStaffId_idx" ON "Notification"("recipientStaffId");

-- CreateIndex
CREATE INDEX "Notification_facilityId_idx" ON "Notification"("facilityId");

-- CreateIndex
CREATE INDEX "Notification_recipientStaffId_readAt_idx" ON "Notification"("recipientStaffId", "readAt");

-- CreateIndex
CREATE INDEX "Notification_recipientStaffId_createdAt_idx" ON "Notification"("recipientStaffId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_patientId_idx" ON "Notification"("patientId");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_recipientStaffId_fkey" FOREIGN KEY ("recipientStaffId") REFERENCES "HospitalStaffProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
