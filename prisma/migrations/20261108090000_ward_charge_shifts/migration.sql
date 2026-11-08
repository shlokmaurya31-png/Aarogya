-- Flagship 3a: the charge nurse per shift (docs/OFFLINE_NURSING_DESIGN.md §12.9).
-- Additive: a new table; nothing existing changes. Ward.chargeNurseStaffId stays
-- the fallback when no shift is on.

-- CreateEnum
CREATE TYPE "WardChargeShiftStatus" AS ENUM ('ACTIVE', 'CANCELLED');

-- CreateTable
CREATE TABLE "WardChargeShift" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "wardId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "status" "WardChargeShiftStatus" NOT NULL DEFAULT 'ACTIVE',
    "assignedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "cancelledByUserId" TEXT,

    CONSTRAINT "WardChargeShift_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WardChargeShift_window" CHECK ("endAt" > "startAt")
);

-- CreateIndex
CREATE INDEX "WardChargeShift_wardId_startAt_idx" ON "WardChargeShift"("wardId", "startAt");

-- CreateIndex
CREATE INDEX "WardChargeShift_facilityId_staffId_idx" ON "WardChargeShift"("facilityId", "staffId");

-- AddForeignKey
ALTER TABLE "WardChargeShift" ADD CONSTRAINT "WardChargeShift_wardId_fkey" FOREIGN KEY ("wardId") REFERENCES "Ward"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One charge nurse at a time per ward: two ACTIVE shifts on one ward never
-- overlap, half-open [startAt, endAt), so a 08:00–14:00 shift and a
-- 14:00–20:00 shift meet without overlapping. The service checks first for a
-- clear message; this is the guarantee under a race.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "WardChargeShift" ADD CONSTRAINT "ward_charge_shift_no_overlap"
  EXCLUDE USING gist ("wardId" WITH =, tsrange("startAt", "endAt", '[)') WITH &&)
  WHERE ("status" = 'ACTIVE');
