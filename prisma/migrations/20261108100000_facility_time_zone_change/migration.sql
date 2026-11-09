-- Flagship 3b: changing a facility's time zone (request and approval).
-- Additive: a new table; Facility.timeZone itself is unchanged here.

-- CreateEnum
CREATE TYPE "FacilityTimeZoneChangeStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "FacilityTimeZoneChange" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "fromTimeZone" TEXT NOT NULL,
    "toTimeZone" TEXT NOT NULL,
    "writtenRequest" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "FacilityTimeZoneChangeStatus" NOT NULL DEFAULT 'REQUESTED',
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "futureAppointments" INTEGER,
    "confirmedFutureAppointments" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "FacilityTimeZoneChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FacilityTimeZoneChange_facilityId_status_idx" ON "FacilityTimeZoneChange"("facilityId", "status");

-- CreateIndex
CREATE INDEX "FacilityTimeZoneChange_status_requestedAt_idx" ON "FacilityTimeZoneChange"("status", "requestedAt");

-- One open request per facility at a time.
CREATE UNIQUE INDEX "FacilityTimeZoneChange_one_open" ON "FacilityTimeZoneChange"("facilityId") WHERE "status" = 'REQUESTED';

-- The patient is told when a booked visit's facility changes its time zone.
ALTER TYPE "PersonNotificationKind" ADD VALUE 'APPOINTMENT_TIME_ZONE_CHANGED';
