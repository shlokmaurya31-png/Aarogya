-- Phase C6 — interoperability control plane (PostgreSQL).
-- Mirrors prisma/migrations/20260912120000_phase_c6_integration_control_plane.
--
-- Strictly additive: four new tables plus nullable/defaulted columns on the
-- existing InteropConnection. No DROP, no DELETE, no TRUNCATE, no retype. No
-- row in any existing table is read or written.
--
-- Every index name here is under PostgreSQL's 63-character identifier limit.
-- ExternalParticipant's unique key is explicitly shortened for exactly that
-- reason; the generated name would have been 64 characters and silently
-- truncated, drifting this tree from the SQLite one.
--
-- Foreign keys are declared after every table exists, so a replay from zero
-- never references a table that has not yet been created.

-- AlterTable
ALTER TABLE "InteropConnection" ADD COLUMN     "protocolVersion" TEXT,
ADD COLUMN     "sandboxVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "productionVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "productionApprovedByUserId" TEXT,
ADD COLUMN     "productionApprovedAt" TIMESTAMP(3),
ADD COLUMN     "productionApprovalNote" TEXT,
ADD COLUMN     "disabledAt" TIMESTAMP(3),
ADD COLUMN     "disabledByUserId" TEXT,
ADD COLUMN     "disabledReason" TEXT,
ADD COLUMN     "lastSuccessAt" TIMESTAMP(3),
ADD COLUMN     "lastFailureAt" TIMESTAMP(3),
ADD COLUMN     "lastFailureCategory" TEXT,
ADD COLUMN     "lastHealthCheckAt" TIMESTAMP(3),
ADD COLUMN     "lastHealthState" TEXT,
ADD COLUMN     "configRevision" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "IntegrationConfigRevision" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "changeKind" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changedFields" TEXT,
    "reason" TEXT,
    "changedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationConfigRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationCertificate" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "usage" TEXT NOT NULL,
    "role" TEXT DEFAULT 'CURRENT',
    "retiredAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
    "materialRef" TEXT,
    "subject" TEXT,
    "issuer" TEXT,
    "serial" TEXT,
    "fingerprint" TEXT,
    "notBefore" TIMESTAMP(3),
    "notAfter" TIMESTAMP(3),
    "activatesAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "checkError" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationCertificate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalParticipant" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "system" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "externalIdSystem" TEXT,
    "environment" TEXT NOT NULL DEFAULT 'SANDBOX',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "trustStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "verifiedAt" TIMESTAMP(3),
    "verifiedByUserId" TEXT,
    "verificationNote" TEXT,
    "suspendedAt" TIMESTAMP(3),
    "suspendedReason" TEXT,
    "payerId" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationAlert" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "connectionId" TEXT,
    "system" TEXT NOT NULL,
    "alertType" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'WARNING',
    "dedupeKey" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
    "firstDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedByUserId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationConfigRevision_connectionId_revision_key" ON "IntegrationConfigRevision"("connectionId", "revision");

-- CreateIndex
CREATE INDEX "IntegrationConfigRevision_facilityId_connectionId_idx" ON "IntegrationConfigRevision"("facilityId", "connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationCertificate_connectionId_usage_role_key" ON "IntegrationCertificate"("connectionId", "usage", "role");

-- CreateIndex
CREATE INDEX "IntegrationCertificate_facilityId_status_idx" ON "IntegrationCertificate"("facilityId", "status");

-- CreateIndex
CREATE INDEX "IntegrationCertificate_notAfter_idx" ON "IntegrationCertificate"("notAfter");

-- CreateIndex: the environment is part of the key on purpose. A sandbox
-- counterparty and a production counterparty with the same code are different
-- rows, so sandbox trust can never be inherited by a live exchange.
CREATE UNIQUE INDEX "ExternalParticipant_facility_system_env_extid_key" ON "ExternalParticipant"("facilityId", "system", "environment", "externalId");

-- CreateIndex
CREATE INDEX "ExternalParticipant_facilityId_system_trustStatus_idx" ON "ExternalParticipant"("facilityId", "system", "trustStatus");

-- CreateIndex
CREATE INDEX "ExternalParticipant_facilityId_type_idx" ON "ExternalParticipant"("facilityId", "type");

-- CreateIndex: this unique constraint IS the alert de-duplication mechanism.
-- A repeating condition collides here instead of flooding the operator's list,
-- and it holds under concurrent detection because it is enforced by the
-- database rather than by a check-then-insert.
CREATE UNIQUE INDEX "IntegrationAlert_facilityId_dedupeKey_key" ON "IntegrationAlert"("facilityId", "dedupeKey");

-- CreateIndex
CREATE INDEX "IntegrationAlert_facilityId_status_severity_idx" ON "IntegrationAlert"("facilityId", "status", "severity");

-- CreateIndex
CREATE INDEX "IntegrationAlert_facilityId_system_idx" ON "IntegrationAlert"("facilityId", "system");

-- AddForeignKey
ALTER TABLE "IntegrationConfigRevision" ADD CONSTRAINT "IntegrationConfigRevision_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "InteropConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationCertificate" ADD CONSTRAINT "IntegrationCertificate_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "InteropConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationAlert" ADD CONSTRAINT "IntegrationAlert_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "InteropConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
