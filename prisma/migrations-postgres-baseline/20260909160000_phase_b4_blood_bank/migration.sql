-- Phase B4 Blood Bank & Transfusion Management. Additive; mirrors
-- prisma/migrations/20260909153546_phase_b4_blood_bank. Composes canonical
-- Patient/Encounter/Item-ItemLot-StockLocation/ClinicalNote/AuditEvent — no
-- parallel patient/encounter/inventory/audit. Blood units are serialized; a
-- unit's own status column is the concurrency-control point (guarded updateMany),
-- so no EXCLUDE/partial constraint is needed here. No compatibility algorithm is
-- encoded in the schema — result fields hold explicit lab/authorized values only.

-- CreateEnum
CREATE TYPE "AboGroup" AS ENUM ('A', 'B', 'AB', 'O');
CREATE TYPE "RhStatus" AS ENUM ('POSITIVE', 'NEGATIVE');
CREATE TYPE "BloodUnitStatus" AS ENUM ('AVAILABLE', 'RESERVED', 'ISSUED', 'IN_TRANSIT', 'TRANSFUSING', 'TRANSFUSED', 'RETURNED', 'WASTED', 'QUARANTINED', 'EXPIRED', 'DISCARDED');
CREATE TYPE "BloodRequestStatus" AS ENUM ('REQUESTED', 'REVIEWED', 'APPROVED', 'COMPATIBILITY_PENDING', 'READY', 'ISSUED', 'COMPLETED', 'CANCELLED', 'REJECTED');
CREATE TYPE "BloodRequestPriority" AS ENUM ('ROUTINE', 'URGENT', 'EMERGENCY');
CREATE TYPE "BloodCompatibilityStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPATIBLE', 'INCOMPATIBLE', 'CANCELLED');
CREATE TYPE "BloodReservationStatus" AS ENUM ('ACTIVE', 'RELEASED', 'CONSUMED');
CREATE TYPE "TransfusionStatus" AS ENUM ('RECEIVED', 'IN_PROGRESS', 'PAUSED', 'COMPLETED', 'STOPPED');
CREATE TYPE "TransfusionReactionStatus" AS ENUM ('REPORTED', 'UNDER_REVIEW', 'ESCALATED', 'RESOLVED');

-- CreateTable
CREATE TABLE "BloodProduct" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "componentType" TEXT NOT NULL,
    "defaultUnitDescription" TEXT,
    "storageRequirement" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "itemId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BloodProduct_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BloodUnit" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "unitNumber" TEXT NOT NULL,
    "aboGroup" "AboGroup",
    "rhStatus" "RhStatus",
    "bloodGroupStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "collectedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "status" "BloodUnitStatus" NOT NULL DEFAULT 'QUARANTINED',
    "itemLotId" TEXT,
    "locationId" TEXT,
    "donorReference" TEXT,
    "sourceOrganization" TEXT,
    "collectionEventRef" TEXT,
    "quarantineReason" TEXT,
    "recalled" BOOLEAN NOT NULL DEFAULT false,
    "recallReason" TEXT,
    "notes" TEXT,
    "registeredByStaffId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BloodUnit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BloodTypingRecord" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT,
    "encounterId" TEXT,
    "unitId" TEXT,
    "aboGroup" "AboGroup",
    "rhStatus" "RhStatus",
    "antibodyScreen" TEXT,
    "specimenRef" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "performedByStaffId" TEXT,
    "verifiedByStaffId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BloodTypingRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BloodRequest" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "productId" TEXT,
    "productName" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "priority" "BloodRequestPriority" NOT NULL DEFAULT 'ROUTINE',
    "indication" TEXT,
    "status" "BloodRequestStatus" NOT NULL DEFAULT 'REQUESTED',
    "requestedByStaffId" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requiredBy" TIMESTAMP(3),
    "reviewedByStaffId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "approvedByStaffId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "cancelledReason" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "emergencyRelease" BOOLEAN NOT NULL DEFAULT false,
    "emergencyReason" TEXT,
    "emergencyAuthorizedByStaffId" TEXT,
    "emergencyAuthorizedAt" TIMESTAMP(3),
    "surgeryId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BloodRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BloodCompatibilityTest" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "unitId" TEXT,
    "testType" TEXT NOT NULL DEFAULT 'CROSSMATCH',
    "aboResult" "AboGroup",
    "rhResult" "RhStatus",
    "antibodyScreen" TEXT,
    "crossmatchResult" TEXT,
    "status" "BloodCompatibilityStatus" NOT NULL DEFAULT 'PENDING',
    "testedByStaffId" TEXT,
    "verifiedByStaffId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BloodCompatibilityTest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BloodReservation" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "status" "BloodReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "reservedByStaffId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "releasedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BloodReservation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BloodIssue" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "compatibilityTestId" TEXT,
    "emergencyRelease" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'ISSUED',
    "issuedByStaffId" TEXT NOT NULL,
    "issueLocation" TEXT,
    "recipientLocation" TEXT,
    "dispatchedByStaffId" TEXT,
    "dispatchedAt" TIMESTAMP(3),
    "receivedByStaffId" TEXT,
    "receivedAt" TIMESTAMP(3),
    "returnedReason" TEXT,
    "returnedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BloodIssue_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Transfusion" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "status" "TransfusionStatus" NOT NULL DEFAULT 'RECEIVED',
    "administeredByStaffId" TEXT,
    "patientIdentityVerified" BOOLEAN NOT NULL DEFAULT false,
    "unitIdentityVerified" BOOLEAN NOT NULL DEFAULT false,
    "productVerified" BOOLEAN NOT NULL DEFAULT false,
    "bloodGroupReviewed" BOOLEAN NOT NULL DEFAULT false,
    "compatibilityReviewed" BOOLEAN NOT NULL DEFAULT false,
    "expiryReviewed" BOOLEAN NOT NULL DEFAULT false,
    "secondCheckStaffId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "stoppedReason" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Transfusion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TransfusionObservation" (
    "id" TEXT NOT NULL,
    "transfusionId" TEXT NOT NULL,
    "observationType" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "recordedByStaffId" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TransfusionObservation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TransfusionReaction" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "transfusionId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "status" "TransfusionReactionStatus" NOT NULL DEFAULT 'REPORTED',
    "reportedByStaffId" TEXT NOT NULL,
    "reportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "symptoms" TEXT,
    "actionTaken" TEXT,
    "escalationRef" TEXT,
    "resolvedByStaffId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TransfusionReaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BloodProduct_facilityId_idx" ON "BloodProduct"("facilityId");
CREATE UNIQUE INDEX "BloodProduct_facilityId_code_key" ON "BloodProduct"("facilityId", "code");
CREATE INDEX "BloodUnit_facilityId_status_idx" ON "BloodUnit"("facilityId", "status");
CREATE INDEX "BloodUnit_productId_idx" ON "BloodUnit"("productId");
CREATE INDEX "BloodUnit_expiresAt_idx" ON "BloodUnit"("expiresAt");
CREATE UNIQUE INDEX "BloodUnit_facilityId_unitNumber_key" ON "BloodUnit"("facilityId", "unitNumber");
CREATE INDEX "BloodTypingRecord_facilityId_idx" ON "BloodTypingRecord"("facilityId");
CREATE INDEX "BloodTypingRecord_patientId_idx" ON "BloodTypingRecord"("patientId");
CREATE INDEX "BloodTypingRecord_unitId_idx" ON "BloodTypingRecord"("unitId");
CREATE INDEX "BloodRequest_facilityId_status_idx" ON "BloodRequest"("facilityId", "status");
CREATE INDEX "BloodRequest_patientId_idx" ON "BloodRequest"("patientId");
CREATE INDEX "BloodRequest_encounterId_idx" ON "BloodRequest"("encounterId");
CREATE INDEX "BloodRequest_surgeryId_idx" ON "BloodRequest"("surgeryId");
CREATE INDEX "BloodCompatibilityTest_facilityId_idx" ON "BloodCompatibilityTest"("facilityId");
CREATE INDEX "BloodCompatibilityTest_requestId_idx" ON "BloodCompatibilityTest"("requestId");
CREATE INDEX "BloodCompatibilityTest_unitId_idx" ON "BloodCompatibilityTest"("unitId");
CREATE INDEX "BloodReservation_facilityId_idx" ON "BloodReservation"("facilityId");
CREATE INDEX "BloodReservation_unitId_idx" ON "BloodReservation"("unitId");
CREATE INDEX "BloodReservation_requestId_idx" ON "BloodReservation"("requestId");
CREATE INDEX "BloodReservation_patientId_idx" ON "BloodReservation"("patientId");
CREATE INDEX "BloodIssue_facilityId_idx" ON "BloodIssue"("facilityId");
CREATE INDEX "BloodIssue_unitId_idx" ON "BloodIssue"("unitId");
CREATE INDEX "BloodIssue_requestId_idx" ON "BloodIssue"("requestId");
CREATE INDEX "BloodIssue_patientId_idx" ON "BloodIssue"("patientId");
CREATE INDEX "Transfusion_facilityId_status_idx" ON "Transfusion"("facilityId", "status");
CREATE INDEX "Transfusion_requestId_idx" ON "Transfusion"("requestId");
CREATE INDEX "Transfusion_unitId_idx" ON "Transfusion"("unitId");
CREATE INDEX "Transfusion_patientId_idx" ON "Transfusion"("patientId");
CREATE INDEX "TransfusionObservation_transfusionId_idx" ON "TransfusionObservation"("transfusionId");
CREATE INDEX "TransfusionReaction_facilityId_idx" ON "TransfusionReaction"("facilityId");
CREATE INDEX "TransfusionReaction_transfusionId_idx" ON "TransfusionReaction"("transfusionId");
CREATE INDEX "TransfusionReaction_unitId_idx" ON "TransfusionReaction"("unitId");
CREATE INDEX "TransfusionReaction_patientId_idx" ON "TransfusionReaction"("patientId");

-- AddForeignKey
ALTER TABLE "BloodProduct" ADD CONSTRAINT "BloodProduct_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BloodProduct" ADD CONSTRAINT "BloodProduct_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BloodUnit" ADD CONSTRAINT "BloodUnit_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BloodUnit" ADD CONSTRAINT "BloodUnit_productId_fkey" FOREIGN KEY ("productId") REFERENCES "BloodProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BloodUnit" ADD CONSTRAINT "BloodUnit_itemLotId_fkey" FOREIGN KEY ("itemLotId") REFERENCES "ItemLot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BloodUnit" ADD CONSTRAINT "BloodUnit_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BloodTypingRecord" ADD CONSTRAINT "BloodTypingRecord_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "BloodUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BloodRequest" ADD CONSTRAINT "BloodRequest_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BloodRequest" ADD CONSTRAINT "BloodRequest_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BloodRequest" ADD CONSTRAINT "BloodRequest_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BloodRequest" ADD CONSTRAINT "BloodRequest_productId_fkey" FOREIGN KEY ("productId") REFERENCES "BloodProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BloodCompatibilityTest" ADD CONSTRAINT "BloodCompatibilityTest_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "BloodRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BloodCompatibilityTest" ADD CONSTRAINT "BloodCompatibilityTest_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "BloodUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BloodReservation" ADD CONSTRAINT "BloodReservation_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "BloodUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BloodReservation" ADD CONSTRAINT "BloodReservation_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "BloodRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BloodIssue" ADD CONSTRAINT "BloodIssue_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "BloodUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BloodIssue" ADD CONSTRAINT "BloodIssue_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "BloodRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Transfusion" ADD CONSTRAINT "Transfusion_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Transfusion" ADD CONSTRAINT "Transfusion_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "BloodRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Transfusion" ADD CONSTRAINT "Transfusion_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "BloodUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TransfusionObservation" ADD CONSTRAINT "TransfusionObservation_transfusionId_fkey" FOREIGN KEY ("transfusionId") REFERENCES "Transfusion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TransfusionReaction" ADD CONSTRAINT "TransfusionReaction_transfusionId_fkey" FOREIGN KEY ("transfusionId") REFERENCES "Transfusion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TransfusionReaction" ADD CONSTRAINT "TransfusionReaction_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "BloodUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
