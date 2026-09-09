-- Phase B6 Enterprise Pharmacy & Medication Supply Chain. Additive; mirrors
-- prisma/migrations/20260909210456_phase_b6_enterprise_pharmacy. Orchestration
-- over the canonical medication + inventory core — MedicationOrder, Item/
-- ItemLot/StockBalance/StockLedgerEntry/StockReservation/StockTransfer/
-- WasteRecord, MedicationAdministration, and AuditEvent are all reused. This
-- adds pharmacy-operational records (formulary, requests, returns, recalls,
-- authorized substitutions, storage checks) plus additive medication-master
-- columns on Item, dispense-tracking columns on MedicationOrder, and multi-lot
-- traceability columns on DispensingRecord. No dosing/interaction/AI logic.

-- CreateEnum
CREATE TYPE "PharmacyRequestStatus" AS ENUM ('REQUESTED', 'APPROVED', 'RESERVED', 'ISSUED', 'RECEIVED', 'CANCELLED', 'REJECTED');
CREATE TYPE "MedicationReturnSource" AS ENUM ('WARD', 'PATIENT', 'CANCELLED_ORDER', 'DISCHARGE', 'OTHER');
CREATE TYPE "MedicationReturnClassification" AS ENUM ('RETURN_TO_STOCK', 'QUARANTINE', 'WASTAGE');
CREATE TYPE "MedicationReturnStatus" AS ENUM ('PENDING_INSPECTION', 'COMPLETED', 'CANCELLED');
CREATE TYPE "MedicationRecallStatus" AS ENUM ('OPEN', 'CLOSED');

-- AlterTable (additive medication-master columns on Item)
ALTER TABLE "Item" ADD COLUMN "genericName" TEXT;
ALTER TABLE "Item" ADD COLUMN "brandName" TEXT;
ALTER TABLE "Item" ADD COLUMN "strength" TEXT;
ALTER TABLE "Item" ADD COLUMN "dosageForm" TEXT;
ALTER TABLE "Item" ADD COLUMN "medicationRoute" TEXT;
ALTER TABLE "Item" ADD COLUMN "concentration" TEXT;
ALTER TABLE "Item" ADD COLUMN "therapeuticCategory" TEXT;
ALTER TABLE "Item" ADD COLUMN "controlledClass" TEXT;
ALTER TABLE "Item" ADD COLUMN "highAlert" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Item" ADD COLUMN "storageRequirement" TEXT;
ALTER TABLE "Item" ADD COLUMN "barcode" TEXT;
ALTER TABLE "Item" ADD COLUMN "manufacturer" TEXT;
ALTER TABLE "Item" ADD COLUMN "packSize" TEXT;
ALTER TABLE "Item" ADD COLUMN "dispensingUnit" TEXT;

-- AlterTable (additive dispense-tracking columns on MedicationOrder)
ALTER TABLE "MedicationOrder" ADD COLUMN "dispenseTargetQuantity" DOUBLE PRECISION;
ALTER TABLE "MedicationOrder" ADD COLUMN "dispenseTargetUnit" TEXT;
ALTER TABLE "MedicationOrder" ADD COLUMN "dispensedQuantity" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable (additive multi-lot traceability columns on DispensingRecord)
ALTER TABLE "DispensingRecord" ADD COLUMN "dispenseGroupId" TEXT;
ALTER TABLE "DispensingRecord" ADD COLUMN "itemId" TEXT;
ALTER TABLE "DispensingRecord" ADD COLUMN "itemLotId" TEXT;

-- CreateTable
CREATE TABLE "FormularyEntry" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "restrictions" TEXT,
    "requiresAuthorization" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdByStaffId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FormularyEntry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PharmacyRequest" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" TEXT,
    "requestingLocationId" TEXT,
    "fulfillLocationId" TEXT,
    "patientId" TEXT,
    "encounterId" TEXT,
    "priority" "RequestPriority" NOT NULL DEFAULT 'ROUTINE',
    "status" "PharmacyRequestStatus" NOT NULL DEFAULT 'REQUESTED',
    "requestedByStaffId" TEXT NOT NULL,
    "reviewedByStaffId" TEXT,
    "reservationId" TEXT,
    "transferId" TEXT,
    "reason" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PharmacyRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MedicationReturn" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "medicationOrderId" TEXT,
    "itemId" TEXT NOT NULL,
    "itemLotId" TEXT,
    "locationId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" TEXT,
    "source" "MedicationReturnSource" NOT NULL,
    "classification" "MedicationReturnClassification",
    "status" "MedicationReturnStatus" NOT NULL DEFAULT 'PENDING_INSPECTION',
    "patientId" TEXT,
    "encounterId" TEXT,
    "isControlled" BOOLEAN NOT NULL DEFAULT false,
    "witnessStaffId" TEXT,
    "returnedByStaffId" TEXT NOT NULL,
    "inspectedByStaffId" TEXT,
    "reason" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MedicationReturn_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MedicationRecall" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "itemLotId" TEXT,
    "manufacturer" TEXT,
    "batchRef" TEXT,
    "reason" TEXT NOT NULL,
    "reference" TEXT,
    "status" "MedicationRecallStatus" NOT NULL DEFAULT 'OPEN',
    "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "affectedLocations" JSONB,
    "createdByStaffId" TEXT NOT NULL,
    "closedByStaffId" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MedicationRecall_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MedicationSubstitution" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "medicationOrderId" TEXT NOT NULL,
    "originalDrugName" TEXT NOT NULL,
    "replacementItemId" TEXT,
    "replacementDrugName" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "authorizedByStaffId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MedicationSubstitution_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PharmacyStorageCheck" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "recordedValue" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "status" TEXT,
    "recordedByStaffId" TEXT NOT NULL,
    "notes" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PharmacyStorageCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FormularyEntry_facilityId_itemId_idx" ON "FormularyEntry"("facilityId", "itemId");
CREATE INDEX "FormularyEntry_facilityId_active_idx" ON "FormularyEntry"("facilityId", "active");
CREATE INDEX "PharmacyRequest_facilityId_status_idx" ON "PharmacyRequest"("facilityId", "status");
CREATE INDEX "PharmacyRequest_itemId_idx" ON "PharmacyRequest"("itemId");
CREATE INDEX "PharmacyRequest_encounterId_idx" ON "PharmacyRequest"("encounterId");
CREATE INDEX "MedicationReturn_facilityId_status_idx" ON "MedicationReturn"("facilityId", "status");
CREATE INDEX "MedicationReturn_itemId_idx" ON "MedicationReturn"("itemId");
CREATE INDEX "MedicationReturn_medicationOrderId_idx" ON "MedicationReturn"("medicationOrderId");
CREATE INDEX "MedicationRecall_facilityId_status_idx" ON "MedicationRecall"("facilityId", "status");
CREATE INDEX "MedicationRecall_itemId_idx" ON "MedicationRecall"("itemId");
CREATE INDEX "MedicationRecall_itemLotId_idx" ON "MedicationRecall"("itemLotId");
CREATE INDEX "MedicationSubstitution_facilityId_idx" ON "MedicationSubstitution"("facilityId");
CREATE INDEX "MedicationSubstitution_medicationOrderId_idx" ON "MedicationSubstitution"("medicationOrderId");
CREATE INDEX "PharmacyStorageCheck_facilityId_locationId_idx" ON "PharmacyStorageCheck"("facilityId", "locationId");
CREATE INDEX "DispensingRecord_dispenseGroupId_idx" ON "DispensingRecord"("dispenseGroupId");
CREATE INDEX "DispensingRecord_itemLotId_idx" ON "DispensingRecord"("itemLotId");

-- AddForeignKey
ALTER TABLE "FormularyEntry" ADD CONSTRAINT "FormularyEntry_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FormularyEntry" ADD CONSTRAINT "FormularyEntry_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MedicationReturn" ADD CONSTRAINT "MedicationReturn_medicationOrderId_fkey" FOREIGN KEY ("medicationOrderId") REFERENCES "MedicationOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MedicationSubstitution" ADD CONSTRAINT "MedicationSubstitution_medicationOrderId_fkey" FOREIGN KEY ("medicationOrderId") REFERENCES "MedicationOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
