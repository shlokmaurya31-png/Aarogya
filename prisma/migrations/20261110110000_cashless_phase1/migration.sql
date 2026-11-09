-- Flagship 5, step 5: cashless insurance, phase 1, behind a mock NHCX adapter. Additive: new enums and tables only.

-- CreateEnum
CREATE TYPE "CashlessStatus" AS ENUM ('AWAITING_PATIENT', 'SUBMITTED', 'QUERY', 'APPROVED', 'PARTIAL', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CashlessDocumentStatus" AS ENUM ('PROPOSED', 'APPROVED', 'REMOVED');

-- CreateEnum
CREATE TYPE "CashlessApprovalVia" AS ENUM ('OWNER', 'PROXY');

-- CreateEnum
CREATE TYPE "CashlessDecision" AS ENUM ('APPROVED', 'PARTIAL', 'QUERY', 'REJECTED');

-- CreateEnum
CREATE TYPE "CashlessDecisionReason" AS ENUM ('NOT_COVERED', 'WAITING_PERIOD', 'SUB_LIMIT', 'ROOM_RENT_LIMIT', 'DOCUMENTS_INSUFFICIENT', 'POLICY_INACTIVE', 'OTHER');

-- CreateEnum
CREATE TYPE "CashlessEligibilityResult" AS ENUM ('ELIGIBLE', 'NOT_ELIGIBLE');

-- CreateTable
CREATE TABLE "CashlessRequest" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "coverageId" TEXT NOT NULL,
    "preAuthorizationId" TEXT,
    "status" "CashlessStatus" NOT NULL DEFAULT 'AWAITING_PATIENT',
    "diagnosis" TEXT NOT NULL,
    "plannedProcedure" TEXT NOT NULL,
    "estimateMinor" INTEGER NOT NULL,
    "approvedAmountMinor" INTEGER,
    "decisionReason" "CashlessDecisionReason",
    "queryText" TEXT,
    "queryAnswer" TEXT,
    "queryCount" INTEGER NOT NULL DEFAULT 0,
    "correlationId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "CashlessRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashlessDocument" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "clinicalDocumentId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "round" INTEGER NOT NULL DEFAULT 1,
    "status" "CashlessDocumentStatus" NOT NULL DEFAULT 'PROPOSED',
    "decidedByUserId" TEXT,
    "decidedVia" "CashlessApprovalVia",
    "decidedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashlessDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashlessInsurerMessage" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "externalMessageId" TEXT NOT NULL,
    "decision" "CashlessDecision" NOT NULL,
    "approvedAmountMinor" INTEGER,
    "reason" "CashlessDecisionReason",
    "applied" BOOLEAN NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashlessInsurerMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashlessEligibility" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "checkInId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "result" "CashlessEligibilityResult" NOT NULL,
    "coverageId" TEXT,
    "correlationId" TEXT NOT NULL,
    "checkedByUserId" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashlessEligibility_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CashlessRequest_preAuthorizationId_key" ON "CashlessRequest"("preAuthorizationId");

-- CreateIndex
CREATE UNIQUE INDEX "CashlessRequest_correlationId_key" ON "CashlessRequest"("correlationId");

-- CreateIndex
CREATE INDEX "CashlessRequest_facilityId_status_idx" ON "CashlessRequest"("facilityId", "status");

-- CreateIndex
CREATE INDEX "CashlessRequest_patientId_idx" ON "CashlessRequest"("patientId");

-- CreateIndex
CREATE INDEX "CashlessRequest_encounterId_idx" ON "CashlessRequest"("encounterId");

-- CreateIndex
CREATE INDEX "CashlessDocument_facilityId_idx" ON "CashlessDocument"("facilityId");

-- CreateIndex
CREATE UNIQUE INDEX "CashlessDocument_requestId_clinicalDocumentId_key" ON "CashlessDocument"("requestId", "clinicalDocumentId");

-- CreateIndex
CREATE INDEX "CashlessInsurerMessage_requestId_idx" ON "CashlessInsurerMessage"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "CashlessInsurerMessage_facilityId_externalMessageId_key" ON "CashlessInsurerMessage"("facilityId", "externalMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "CashlessEligibility_correlationId_key" ON "CashlessEligibility"("correlationId");

-- CreateIndex
CREATE INDEX "CashlessEligibility_facilityId_checkInId_idx" ON "CashlessEligibility"("facilityId", "checkInId");

-- AddForeignKey
ALTER TABLE "CashlessDocument" ADD CONSTRAINT "CashlessDocument_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "CashlessRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashlessInsurerMessage" ADD CONSTRAINT "CashlessInsurerMessage_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "CashlessRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

