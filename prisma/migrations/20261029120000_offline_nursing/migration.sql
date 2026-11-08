-- Flagship 2, step 5: offline nursing, phase 1 (docs/OFFLINE_NURSING_DESIGN.md §13).
-- Additive: new enums and tables, three nullable or defaulted columns. The one
-- index rebuilt below keeps exactly the rows it covered (no row has the new
-- column set yet), so nothing existing changes meaning.

CREATE TYPE "WardDeviceStatus" AS ENUM ('ACTIVE', 'REVOKED');

CREATE TYPE "DoseLeaseStatus" AS ENUM ('ACTIVE', 'RELEASED', 'EXPIRED', 'OVERRIDDEN');

CREATE TYPE "OfflineCommandKind" AS ENUM ('DOSE_GIVEN', 'DOSE_HELD', 'DOSE_REFUSED');

CREATE TYPE "OfflineCommandOutcome" AS ENUM ('APPLIED', 'APPLIED_WITH_CONFLICT', 'REFUSED');

CREATE TYPE "OfflineRefusalReason" AS ENUM ('ONLINE_ONLY', 'LEASE_EXPIRED', 'NOT_LEASED', 'NOT_DUE', 'UNKNOWN_DOSE');

CREATE TYPE "OfflineConflictKind" AS ENUM ('POSSIBLE_DOUBLE_DOSE', 'ORDER_CHANGED', 'LEASE_OVERRIDDEN', 'LEASE_EXPIRED', 'NOT_LEASED', 'ONLINE_ONLY', 'CLOCK_SUSPECT');

CREATE TYPE "OfflineConflictSeverity" AS ENUM ('WARNING', 'CRITICAL');

CREATE TYPE "OfflineConflictStatus" AS ENUM ('OPEN', 'RESOLVED');

ALTER TABLE "Facility" ADD COLUMN     "offlinePackHours" INTEGER NOT NULL DEFAULT 4;

ALTER TABLE "MedicationAdministration" ADD COLUMN     "offlineGivenForAdministrationId" TEXT;

ALTER TABLE "Ward" ADD COLUMN     "chargeNurseStaffId" TEXT;

CREATE TABLE "WardDevice" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "wardId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" "WardDeviceStatus" NOT NULL DEFAULT 'ACTIVE',
    "registeredByUserId" TEXT NOT NULL,
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),

    CONSTRAINT "WardDevice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WardPack" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "nurseStaffId" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "clockOffsetMs" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "WardPack_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DoseLease" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "administrationId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "packId" TEXT NOT NULL,
    "nurseStaffId" TEXT NOT NULL,
    "status" "DoseLeaseStatus" NOT NULL DEFAULT 'ACTIVE',
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "endedByUserId" TEXT,
    "overrideReason" TEXT,
    "holderToldAt" TIMESTAMP(3),

    CONSTRAINT "DoseLease_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OfflineCommand" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "clientOperationId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "nurseStaffId" TEXT NOT NULL,
    "kind" "OfflineCommandKind" NOT NULL,
    "administrationId" TEXT NOT NULL,
    "deviceTime" TIMESTAMP(3) NOT NULL,
    "appliedTime" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcome" "OfflineCommandOutcome" NOT NULL,
    "refusalReason" "OfflineRefusalReason",
    "reasonCode" TEXT,
    "resultAdministrationId" TEXT,

    CONSTRAINT "OfflineCommand_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OfflineConflict" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "commandId" TEXT NOT NULL,
    "administrationId" TEXT NOT NULL,
    "kind" "OfflineConflictKind" NOT NULL,
    "severity" "OfflineConflictSeverity" NOT NULL,
    "status" "OfflineConflictStatus" NOT NULL DEFAULT 'OPEN',
    "taskId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,

    CONSTRAINT "OfflineConflict_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WardDevice_facilityId_status_idx" ON "WardDevice"("facilityId", "status");

CREATE INDEX "WardPack_deviceId_idx" ON "WardPack"("deviceId");

CREATE INDEX "DoseLease_deviceId_status_idx" ON "DoseLease"("deviceId", "status");

CREATE INDEX "DoseLease_administrationId_idx" ON "DoseLease"("administrationId");

CREATE INDEX "OfflineCommand_deviceId_idx" ON "OfflineCommand"("deviceId");

CREATE UNIQUE INDEX "OfflineCommand_facilityId_clientOperationId_key" ON "OfflineCommand"("facilityId", "clientOperationId");

CREATE INDEX "OfflineConflict_facilityId_status_idx" ON "OfflineConflict"("facilityId", "status");

ALTER TABLE "MedicationAdministration" ADD CONSTRAINT "MedicationAdministration_offlineGivenForAdministrationId_fkey" FOREIGN KEY ("offlineGivenForAdministrationId") REFERENCES "MedicationAdministration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WardDevice" ADD CONSTRAINT "WardDevice_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WardDevice" ADD CONSTRAINT "WardDevice_wardId_fkey" FOREIGN KEY ("wardId") REFERENCES "Ward"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WardPack" ADD CONSTRAINT "WardPack_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "WardDevice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DoseLease" ADD CONSTRAINT "DoseLease_administrationId_fkey" FOREIGN KEY ("administrationId") REFERENCES "MedicationAdministration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DoseLease" ADD CONSTRAINT "DoseLease_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "WardDevice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DoseLease" ADD CONSTRAINT "DoseLease_packId_fkey" FOREIGN KEY ("packId") REFERENCES "WardPack"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OfflineConflict" ADD CONSTRAINT "OfflineConflict_commandId_fkey" FOREIGN KEY ("commandId") REFERENCES "OfflineCommand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One ACTIVE lease per dose: a dose can be given offline on one device only.
CREATE UNIQUE INDEX "DoseLease_one_active_per_administration" ON "DoseLease"("administrationId") WHERE "status" = 'ACTIVE';

-- A scheduled dose is still one row per (order, time); an offline GIVEN recorded
-- for a dose no longer due is a second fact beside it, so it is not counted.
DROP INDEX "MedicationAdministration_order_scheduledAt_key";
CREATE UNIQUE INDEX "MedicationAdministration_order_scheduledAt_key"
  ON "MedicationAdministration"("medicationOrderId", "scheduledAt")
  WHERE "lateForAdministrationId" IS NULL AND "offlineGivenForAdministrationId" IS NULL;

-- The offline limit is 1 to 12 hours (decided: 4 by default, up to 12).
ALTER TABLE "Facility" ADD CONSTRAINT "Facility_offlinePackHours_range" CHECK ("offlinePackHours" BETWEEN 1 AND 12);
