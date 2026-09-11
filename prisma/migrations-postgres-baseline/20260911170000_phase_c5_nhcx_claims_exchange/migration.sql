-- Phase C5 — NHCX / health claims exchange foundation (PostgreSQL).
-- Mirrors prisma/migrations/20260911170000_phase_c5_nhcx_claims_exchange.
--
-- Fully ADDITIVE: seven new tables. No ALTER, no DROP, no retype, and no row in
-- any existing table is read or written. Phase 5 billing (Claim, Invoice,
-- Payment) and the C1–C4 interoperability tables are untouched.
--
-- Foreign keys are declared after every table exists, so a replay from zero
-- never references a table that has not yet been created — the defect class
-- found during the Phase B gate.

-- CreateTable
CREATE TABLE "ClaimSubmission" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "submissionType" TEXT NOT NULL DEFAULT 'ORIGINAL',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "claimedAmountMinor" INTEGER NOT NULL,
    "approvedAmountMinor" INTEGER,
    "correctionReason" TEXT,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT,
    "coverageId" TEXT NOT NULL,
    "payerId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "snapshot" JSONB,
    "snapshotHash" TEXT,
    "snapshotBytes" INTEGER,
    "externalReference" TEXT,
    "builtAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "builtByUserId" TEXT NOT NULL,
    "submittedByUserId" TEXT,
    "lockVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClaimSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClaimSubmissionDocument" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "documentVersion" INTEGER NOT NULL,
    "documentType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "contentHash" TEXT,
    "dataClass" TEXT,
    "includedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClaimSubmissionDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NhcxExchange" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "submissionId" TEXT,
    "claimId" TEXT,
    "preAuthorizationId" TEXT,
    "exchangeType" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'OUTBOUND',
    "protocolState" TEXT NOT NULL DEFAULT 'NOT_SUBMITTED',
    "idempotencyKey" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "externalReference" TEXT,
    "errorCategory" TEXT,
    "errorMessage" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "nextRetryAt" TIMESTAMP(3),
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "latencyMs" INTEGER,
    "requestedByUserId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NhcxExchange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NhcxCallbackEvent" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "exchangeId" TEXT,
    "correlationId" TEXT NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "messageType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACCEPTED',
    "rejectionReason" TEXT,
    "payloadHash" TEXT,
    "payloadBytes" INTEGER,
    "sourceAddress" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "NhcxCallbackEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClaimQuery" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "externalQueryId" TEXT,
    "questionText" TEXT NOT NULL,
    "reasonCode" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "responseText" TEXT,
    "respondedByUserId" TEXT,
    "respondedAt" TIMESTAMP(3),
    "responseDocumentIds" TEXT,
    "dueAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClaimQuery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClaimSettlement" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "externalSettlementRef" TEXT NOT NULL,
    "settledAmountMinor" INTEGER NOT NULL,
    "settlementDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'NOTIFIED',
    "paymentId" TEXT,
    "reconciledAt" TIMESTAMP(3),
    "reconciledByUserId" TEXT,
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClaimSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationException" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "claimId" TEXT,
    "invoiceId" TEXT,
    "paymentId" TEXT,
    "settlementId" TEXT,
    "exceptionType" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'WARNING',
    "expectedAmountMinor" INTEGER,
    "actualAmountMinor" INTEGER,
    "varianceMinor" INTEGER,
    "detail" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolutionNote" TEXT,
    "resolvedByUserId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReconciliationException_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClaimSubmission_claimId_version_key" ON "ClaimSubmission"("claimId", "version");

-- CreateIndex
CREATE INDEX "ClaimSubmission_facilityId_status_idx" ON "ClaimSubmission"("facilityId", "status");

-- CreateIndex
CREATE INDEX "ClaimSubmission_claimId_idx" ON "ClaimSubmission"("claimId");

-- CreateIndex
CREATE UNIQUE INDEX "ClaimSubmissionDocument_submission_document_version_key" ON "ClaimSubmissionDocument"("submissionId", "documentId", "documentVersion");

-- CreateIndex
CREATE INDEX "ClaimSubmissionDocument_facilityId_idx" ON "ClaimSubmissionDocument"("facilityId");

-- CreateIndex: the idempotency and correlation guarantees are database
-- constraints, not application checks — under a concurrent dispatch one inserter
-- loses on the unique index rather than a second external request being created.
CREATE UNIQUE INDEX "NhcxExchange_idempotencyKey_key" ON "NhcxExchange"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "NhcxExchange_correlationId_key" ON "NhcxExchange"("correlationId");

-- CreateIndex
CREATE INDEX "NhcxExchange_facilityId_protocolState_idx" ON "NhcxExchange"("facilityId", "protocolState");

-- CreateIndex
CREATE INDEX "NhcxExchange_facilityId_exchangeType_idx" ON "NhcxExchange"("facilityId", "exchangeType");

-- CreateIndex
CREATE INDEX "NhcxExchange_nextRetryAt_idx" ON "NhcxExchange"("nextRetryAt");

-- CreateIndex
CREATE INDEX "NhcxExchange_externalReference_idx" ON "NhcxExchange"("externalReference");

-- CreateIndex: replay guard for inbound callbacks.
CREATE UNIQUE INDEX "NhcxCallbackEvent_facilityId_messageType_externalEventId_key" ON "NhcxCallbackEvent"("facilityId", "messageType", "externalEventId");

-- CreateIndex
CREATE INDEX "NhcxCallbackEvent_facilityId_status_idx" ON "NhcxCallbackEvent"("facilityId", "status");

-- CreateIndex
CREATE INDEX "NhcxCallbackEvent_correlationId_idx" ON "NhcxCallbackEvent"("correlationId");

-- CreateIndex
CREATE INDEX "ClaimQuery_facilityId_status_idx" ON "ClaimQuery"("facilityId", "status");

-- CreateIndex
CREATE INDEX "ClaimQuery_claimId_idx" ON "ClaimQuery"("claimId");

-- CreateIndex: a settlement reference may not be counted twice in a facility.
CREATE UNIQUE INDEX "ClaimSettlement_facilityId_externalSettlementRef_key" ON "ClaimSettlement"("facilityId", "externalSettlementRef");

-- CreateIndex
CREATE INDEX "ClaimSettlement_facilityId_status_idx" ON "ClaimSettlement"("facilityId", "status");

-- CreateIndex
CREATE INDEX "ClaimSettlement_claimId_idx" ON "ClaimSettlement"("claimId");

-- CreateIndex
CREATE INDEX "ReconciliationException_facilityId_status_idx" ON "ReconciliationException"("facilityId", "status");

-- CreateIndex
CREATE INDEX "ReconciliationException_facilityId_exceptionType_idx" ON "ReconciliationException"("facilityId", "exceptionType");

-- CreateIndex
CREATE INDEX "ReconciliationException_claimId_idx" ON "ReconciliationException"("claimId");

-- AddForeignKey
ALTER TABLE "ClaimSubmission" ADD CONSTRAINT "ClaimSubmission_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "Claim"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimSubmissionDocument" ADD CONSTRAINT "ClaimSubmissionDocument_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "ClaimSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NhcxExchange" ADD CONSTRAINT "NhcxExchange_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "ClaimSubmission"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NhcxCallbackEvent" ADD CONSTRAINT "NhcxCallbackEvent_exchangeId_fkey" FOREIGN KEY ("exchangeId") REFERENCES "NhcxExchange"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimQuery" ADD CONSTRAINT "ClaimQuery_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "ClaimSubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
