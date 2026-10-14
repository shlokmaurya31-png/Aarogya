-- Phase C1 — India Digital Health Interoperability Foundation (PostgreSQL).
-- Mirrors prisma/migrations/20260911130000_phase_c1_interoperability_foundation.
--
-- Fully ADDITIVE: eight new tables plus their indexes and foreign keys. No
-- existing table is rebuilt, no column is dropped or retyped, and no clinical
-- row is touched. The canonical Phase B domain is unchanged by design — this
-- migration only adds the interoperability boundary above it.
--
-- Foreign keys are emitted as trailing ALTER TABLE ADD CONSTRAINT statements
-- rather than inline REFERENCES, so no table is referenced before it exists.
-- That is precisely the defect the Phase B gate found in the B10 baseline:
-- SQLite tolerates a forward FK reference, PostgreSQL rejects it with 42P01.
-- See docs/PHASE_B_FINAL_INTEGRITY_GATE.md §2.

-- CreateTable
CREATE TABLE "ExternalIdentifier" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "system" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "use" TEXT NOT NULL DEFAULT 'OFFICIAL',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "source" TEXT NOT NULL DEFAULT 'LOCAL_ENTRY',
    "verificationStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "verifiedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "syncStatus" TEXT,
    "syncError" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "externalUpdatedAt" TIMESTAMP(3),
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "createdByStaffId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalIdentifier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InteropConsent" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "recipientType" TEXT NOT NULL,
    "recipientIdentifier" TEXT NOT NULL,
    "recipientSystem" TEXT,
    "recipientName" TEXT,
    "externalConsentRef" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "revokedByStaffId" TEXT,
    "declinedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "grantedBy" TEXT,
    "source" TEXT NOT NULL DEFAULT 'LOCAL',
    "createdByStaffId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InteropConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InteropConsentScope" (
    "id" TEXT NOT NULL,
    "consentId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InteropConsentScope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HealthInformationExchange" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT,
    "direction" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "consentId" TEXT,
    "destinationSystem" TEXT NOT NULL,
    "destinationEndpoint" TEXT,
    "requestedScopes" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "correlationId" TEXT,
    "externalRequestId" TEXT,
    "requestedByStaffId" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "authorizedAt" TIMESTAMP(3),
    "authorizedByStaffId" TEXT,
    "processingStartedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "failedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 3,
    "nextRetryAt" TIMESTAMP(3),
    "lastError" TEXT,
    "resourceCount" INTEGER,
    "bundleHash" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HealthInformationExchange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InteropProvenance" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "direction" TEXT NOT NULL,
    "dataOrigin" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "externalResourceType" TEXT,
    "externalResourceId" TEXT,
    "externalVersion" TEXT,
    "exchangeId" TEXT,
    "consentId" TEXT,
    "externalIdentifierId" TEXT,
    "actorUserId" TEXT,
    "actorStaffId" TEXT,
    "correlationId" TEXT,
    "requestId" TEXT,
    "payloadHash" TEXT,
    "payloadContentType" TEXT,
    "payloadBytes" INTEGER,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InteropProvenance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportedResource" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "externalResourceId" TEXT NOT NULL,
    "externalVersion" TEXT,
    "localEntityType" TEXT,
    "localEntityId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "conflictReason" TEXT,
    "rejectionReason" TEXT,
    "exchangeId" TEXT,
    "payloadHash" TEXT,
    "payloadBytes" INTEGER,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "importedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "reviewedByStaffId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportedResource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TerminologyMapping" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT,
    "domain" TEXT NOT NULL,
    "localSystem" TEXT NOT NULL,
    "localCode" TEXT NOT NULL,
    "localDisplay" TEXT,
    "externalSystem" TEXT NOT NULL,
    "externalCode" TEXT NOT NULL,
    "externalDisplay" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "mapVersion" TEXT,
    "createdByStaffId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TerminologyMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InteropConnection" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "system" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'DISABLED',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "baseUrl" TEXT,
    "clientIdEnvVar" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
    "capabilities" JSONB,
    "lastSyncedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InteropConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExternalIdentifier_facilityId_entityType_entityId_idx" ON "ExternalIdentifier"("facilityId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "ExternalIdentifier_system_value_idx" ON "ExternalIdentifier"("system", "value");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalIdentifier_facilityId_system_value_key" ON "ExternalIdentifier"("facilityId", "system", "value");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalIdentifier_facilityId_entityType_entityId_system_key" ON "ExternalIdentifier"("facilityId", "entityType", "entityId", "system");

-- CreateIndex
CREATE INDEX "InteropConsent_facilityId_patientId_idx" ON "InteropConsent"("facilityId", "patientId");

-- CreateIndex
CREATE INDEX "InteropConsent_facilityId_status_idx" ON "InteropConsent"("facilityId", "status");

-- CreateIndex
CREATE INDEX "InteropConsent_expiresAt_idx" ON "InteropConsent"("expiresAt");

-- CreateIndex
CREATE INDEX "InteropConsentScope_consentId_idx" ON "InteropConsentScope"("consentId");

-- CreateIndex
CREATE UNIQUE INDEX "InteropConsentScope_consentId_scope_key" ON "InteropConsentScope"("consentId", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "HealthInformationExchange_idempotencyKey_key" ON "HealthInformationExchange"("idempotencyKey");

-- CreateIndex
CREATE INDEX "HealthInformationExchange_facilityId_status_idx" ON "HealthInformationExchange"("facilityId", "status");

-- CreateIndex
CREATE INDEX "HealthInformationExchange_facilityId_patientId_idx" ON "HealthInformationExchange"("facilityId", "patientId");

-- CreateIndex
CREATE INDEX "HealthInformationExchange_nextRetryAt_idx" ON "HealthInformationExchange"("nextRetryAt");

-- CreateIndex
CREATE INDEX "InteropProvenance_facilityId_entityType_entityId_idx" ON "InteropProvenance"("facilityId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "InteropProvenance_facilityId_patientId_idx" ON "InteropProvenance"("facilityId", "patientId");

-- CreateIndex
CREATE INDEX "InteropProvenance_sourceSystem_externalResourceId_idx" ON "InteropProvenance"("sourceSystem", "externalResourceId");

-- CreateIndex
CREATE INDEX "ImportedResource_facilityId_status_idx" ON "ImportedResource"("facilityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ImportedResource_facilityId_sourceSystem_resourceType_exter_key" ON "ImportedResource"("facilityId", "sourceSystem", "resourceType", "externalResourceId");

-- CreateIndex
CREATE INDEX "TerminologyMapping_domain_externalSystem_externalCode_idx" ON "TerminologyMapping"("domain", "externalSystem", "externalCode");

-- CreateIndex
CREATE UNIQUE INDEX "TerminologyMapping_facilityId_domain_localSystem_localCode__key" ON "TerminologyMapping"("facilityId", "domain", "localSystem", "localCode", "externalSystem");

-- CreateIndex
CREATE INDEX "InteropConnection_facilityId_idx" ON "InteropConnection"("facilityId");

-- CreateIndex
CREATE UNIQUE INDEX "InteropConnection_facilityId_system_key" ON "InteropConnection"("facilityId", "system");

-- AddForeignKey
ALTER TABLE "InteropConsentScope" ADD CONSTRAINT "InteropConsentScope_consentId_fkey" FOREIGN KEY ("consentId") REFERENCES "InteropConsent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthInformationExchange" ADD CONSTRAINT "HealthInformationExchange_consentId_fkey" FOREIGN KEY ("consentId") REFERENCES "InteropConsent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InteropProvenance" ADD CONSTRAINT "InteropProvenance_exchangeId_fkey" FOREIGN KEY ("exchangeId") REFERENCES "HealthInformationExchange"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InteropProvenance" ADD CONSTRAINT "InteropProvenance_externalIdentifierId_fkey" FOREIGN KEY ("externalIdentifierId") REFERENCES "ExternalIdentifier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportedResource" ADD CONSTRAINT "ImportedResource_exchangeId_fkey" FOREIGN KEY ("exchangeId") REFERENCES "HealthInformationExchange"("id") ON DELETE SET NULL ON UPDATE CASCADE;

