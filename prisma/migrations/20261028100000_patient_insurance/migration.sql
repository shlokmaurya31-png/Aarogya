-- Week 5c: patient insurance and check-in (docs/PATIENT_INSURANCE_DESIGN.md §14).
-- Additive: new tables (cards, card shares, pre-arrival check-ins, claim document
-- requests, facility payment gateways, payment orders, gateway webhooks), new enum
-- values, and nullable columns (AdmissionRequest.plannedAdmissionAt,
-- PatientCoverage.sourceCardId) or a defaulted one (RecordShare.documentIds, empty
-- for every existing share). Nothing existing is changed or removed.
-- CreateEnum
CREATE TYPE "InsurancePayerType" AS ENUM ('PRIVATE_INSURER', 'CORPORATE', 'GOVERNMENT_SCHEME');

-- CreateEnum
CREATE TYPE "InsuranceCardStatus" AS ENUM ('ACTIVE', 'REMOVED');

-- CreateEnum
CREATE TYPE "CardShareStatus" AS ENUM ('ACTIVE', 'ENDED');

-- CreateEnum
CREATE TYPE "PreArrivalKind" AS ENUM ('APPOINTMENT', 'ADMISSION');

-- CreateEnum
CREATE TYPE "PreArrivalStatus" AS ENUM ('SUBMITTED', 'READY', 'NEEDS_DESK', 'ARRIVED', 'LAPSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PreArrivalEligibility" AS ENUM ('SELF_PAY', 'PENDING', 'VERIFIED', 'NOT_VERIFIED');

-- CreateEnum
CREATE TYPE "ClaimDocumentRequestStatus" AS ENUM ('OPEN', 'FULFILLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "FacilityGatewayMode" AS ENUM ('TEST', 'LIVE');

-- CreateEnum
CREATE TYPE "PatientPaymentOrderStatus" AS ENUM ('CREATED', 'PAID', 'FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PersonNotificationKind" ADD VALUE 'CHECKIN_OPEN';
ALTER TYPE "PersonNotificationKind" ADD VALUE 'INSURANCE_UPDATE';
ALTER TYPE "PersonNotificationKind" ADD VALUE 'DOCUMENTS_REQUESTED';
ALTER TYPE "PersonNotificationKind" ADD VALUE 'BILL_READY';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "RecordShareKind" ADD VALUE 'CHECKIN';
ALTER TYPE "RecordShareKind" ADD VALUE 'CLAIM';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ShareEndReason" ADD VALUE 'CHECKIN_ENDED';
ALTER TYPE "ShareEndReason" ADD VALUE 'CLAIM_CLOSED';

-- AlterTable
ALTER TABLE "AdmissionRequest" ADD COLUMN     "plannedAdmissionAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PatientCoverage" ADD COLUMN     "sourceCardId" TEXT;

-- AlterTable
ALTER TABLE "RecordShare" ADD COLUMN     "documentIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "InsuranceCard" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "payerType" "InsurancePayerType" NOT NULL,
    "scheme" TEXT,
    "payerId" TEXT,
    "payerName" TEXT NOT NULL,
    "planName" TEXT,
    "memberIdCipher" TEXT NOT NULL,
    "memberIdLast4" TEXT NOT NULL,
    "policyCipher" TEXT,
    "policyLast4" TEXT,
    "keyVersion" INTEGER NOT NULL,
    "validFrom" TIMESTAMP(3),
    "validTo" TIMESTAMP(3),
    "frontImageRef" TEXT,
    "backImageRef" TEXT,
    "status" "InsuranceCardStatus" NOT NULL DEFAULT 'ACTIVE',
    "addedByPersonId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "InsuranceCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CardShare" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "recipientFacilityId" TEXT NOT NULL,
    "checkInId" TEXT,
    "status" "CardShareStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "endedReason" TEXT,
    "createdByPersonId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "CardShare_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PreArrivalCheckIn" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "kind" "PreArrivalKind" NOT NULL,
    "appointmentId" TEXT,
    "admissionRequestId" TEXT,
    "patientId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "status" "PreArrivalStatus" NOT NULL DEFAULT 'SUBMITTED',
    "needsDeskReason" TEXT,
    "eligibility" "PreArrivalEligibility" NOT NULL,
    "token" TEXT NOT NULL,
    "tokenDay" TEXT NOT NULL,
    "shareId" TEXT,
    "cardShareId" TEXT,
    "submittedByPersonId" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "arrivedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "PreArrivalCheckIn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClaimDocumentRequest" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "ClaimDocumentRequestStatus" NOT NULL DEFAULT 'OPEN',
    "shareId" TEXT,
    "requestedByUserId" TEXT NOT NULL,
    "fulfilledByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fulfilledAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ClaimDocumentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FacilityPaymentGateway" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'RAZORPAY',
    "mode" "FacilityGatewayMode" NOT NULL DEFAULT 'TEST',
    "keyId" TEXT NOT NULL,
    "secretRef" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "configuredByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "FacilityPaymentGateway_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientPaymentOrder" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "mode" "FacilityGatewayMode" NOT NULL,
    "providerOrderRef" TEXT NOT NULL,
    "status" "PatientPaymentOrderStatus" NOT NULL DEFAULT 'CREATED',
    "paymentId" TEXT,
    "providerPaymentRef" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "PatientPaymentOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FacilityGatewayWebhook" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FacilityGatewayWebhook_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InsuranceCard_personId_status_idx" ON "InsuranceCard"("personId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CardShare_checkInId_key" ON "CardShare"("checkInId");

-- CreateIndex
CREATE INDEX "CardShare_personId_status_idx" ON "CardShare"("personId", "status");

-- CreateIndex
CREATE INDEX "CardShare_recipientFacilityId_status_idx" ON "CardShare"("recipientFacilityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PreArrivalCheckIn_appointmentId_key" ON "PreArrivalCheckIn"("appointmentId");

-- CreateIndex
CREATE UNIQUE INDEX "PreArrivalCheckIn_admissionRequestId_key" ON "PreArrivalCheckIn"("admissionRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "PreArrivalCheckIn_shareId_key" ON "PreArrivalCheckIn"("shareId");

-- CreateIndex
CREATE UNIQUE INDEX "PreArrivalCheckIn_cardShareId_key" ON "PreArrivalCheckIn"("cardShareId");

-- CreateIndex
CREATE INDEX "PreArrivalCheckIn_facilityId_status_idx" ON "PreArrivalCheckIn"("facilityId", "status");

-- CreateIndex
CREATE INDEX "PreArrivalCheckIn_personId_idx" ON "PreArrivalCheckIn"("personId");

-- CreateIndex
CREATE UNIQUE INDEX "PreArrivalCheckIn_facilityId_tokenDay_token_key" ON "PreArrivalCheckIn"("facilityId", "tokenDay", "token");

-- CreateIndex
CREATE UNIQUE INDEX "ClaimDocumentRequest_shareId_key" ON "ClaimDocumentRequest"("shareId");

-- CreateIndex
CREATE INDEX "ClaimDocumentRequest_facilityId_status_idx" ON "ClaimDocumentRequest"("facilityId", "status");

-- CreateIndex
CREATE INDEX "ClaimDocumentRequest_patientId_status_idx" ON "ClaimDocumentRequest"("patientId", "status");

-- CreateIndex
CREATE INDEX "ClaimDocumentRequest_claimId_idx" ON "ClaimDocumentRequest"("claimId");

-- CreateIndex
CREATE UNIQUE INDEX "FacilityPaymentGateway_facilityId_key" ON "FacilityPaymentGateway"("facilityId");

-- CreateIndex
CREATE UNIQUE INDEX "PatientPaymentOrder_providerOrderRef_key" ON "PatientPaymentOrder"("providerOrderRef");

-- CreateIndex
CREATE UNIQUE INDEX "PatientPaymentOrder_paymentId_key" ON "PatientPaymentOrder"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "PatientPaymentOrder_providerPaymentRef_key" ON "PatientPaymentOrder"("providerPaymentRef");

-- CreateIndex
CREATE INDEX "PatientPaymentOrder_facilityId_status_idx" ON "PatientPaymentOrder"("facilityId", "status");

-- CreateIndex
CREATE INDEX "PatientPaymentOrder_invoiceId_idx" ON "PatientPaymentOrder"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "FacilityGatewayWebhook_facilityId_externalEventId_key" ON "FacilityGatewayWebhook"("facilityId", "externalEventId");

