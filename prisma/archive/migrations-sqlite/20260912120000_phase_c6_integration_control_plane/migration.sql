-- Phase C6 — interoperability control plane.
--
-- Strictly additive. Three new tables plus nullable columns on the existing
-- InteropConnection. No DROP, no DELETE, no TRUNCATE, no retype, and no change
-- to any Phase B, C1, C2, C3, C4 or C5 table beyond those added columns.
--
-- Every added column is NULLable or carries a DEFAULT, so existing rows remain
-- valid without a data migration. Note what is NOT here: no credential column,
-- no certificate body, no key material. InteropConnection stores an environment
-- variable NAME and the new certificate table stores a REFERENCE, by design.
--
-- SQLite cannot ALTER TABLE ... ADD COLUMN with certain constructs, so Prisma
-- may rebuild a table on this side; these columns are all simple and are added
-- in place.

-- AlterTable
ALTER TABLE "InteropConnection" ADD COLUMN "protocolVersion" TEXT;
ALTER TABLE "InteropConnection" ADD COLUMN "sandboxVerifiedAt" DATETIME;
ALTER TABLE "InteropConnection" ADD COLUMN "productionVerifiedAt" DATETIME;
ALTER TABLE "InteropConnection" ADD COLUMN "productionApprovedByUserId" TEXT;
ALTER TABLE "InteropConnection" ADD COLUMN "productionApprovedAt" DATETIME;
ALTER TABLE "InteropConnection" ADD COLUMN "productionApprovalNote" TEXT;
ALTER TABLE "InteropConnection" ADD COLUMN "disabledAt" DATETIME;
ALTER TABLE "InteropConnection" ADD COLUMN "disabledByUserId" TEXT;
ALTER TABLE "InteropConnection" ADD COLUMN "disabledReason" TEXT;
ALTER TABLE "InteropConnection" ADD COLUMN "lastSuccessAt" DATETIME;
ALTER TABLE "InteropConnection" ADD COLUMN "lastFailureAt" DATETIME;
ALTER TABLE "InteropConnection" ADD COLUMN "lastFailureCategory" TEXT;
ALTER TABLE "InteropConnection" ADD COLUMN "lastHealthCheckAt" DATETIME;
ALTER TABLE "InteropConnection" ADD COLUMN "lastHealthState" TEXT;
ALTER TABLE "InteropConnection" ADD COLUMN "configRevision" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "IntegrationConfigRevision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "changeKind" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changedFields" TEXT,
    "reason" TEXT,
    "changedByUserId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IntegrationConfigRevision_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "InteropConnection" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "IntegrationCertificate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "usage" TEXT NOT NULL,
    "role" TEXT DEFAULT 'CURRENT',
    "retiredAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
    "materialRef" TEXT,
    "subject" TEXT,
    "issuer" TEXT,
    "serial" TEXT,
    "fingerprint" TEXT,
    "notBefore" DATETIME,
    "notAfter" DATETIME,
    "activatesAt" DATETIME,
    "lastCheckedAt" DATETIME,
    "checkError" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "IntegrationCertificate_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "InteropConnection" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ExternalParticipant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "system" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "externalIdSystem" TEXT,
    "environment" TEXT NOT NULL DEFAULT 'SANDBOX',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "trustStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "verifiedAt" DATETIME,
    "verifiedByUserId" TEXT,
    "verificationNote" TEXT,
    "suspendedAt" DATETIME,
    "suspendedReason" TEXT,
    "payerId" TEXT,
    "lastSeenAt" DATETIME,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "IntegrationAlert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "connectionId" TEXT,
    "system" TEXT NOT NULL,
    "alertType" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'WARNING',
    "dedupeKey" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
    "firstDetectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastDetectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" DATETIME,
    "acknowledgedByUserId" TEXT,
    "resolvedAt" DATETIME,
    "resolutionNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "IntegrationAlert_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "InteropConnection" ("id") ON DELETE CASCADE ON UPDATE CASCADE
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
-- A repeating condition collides here instead of flooding the operator's list.
CREATE UNIQUE INDEX "IntegrationAlert_facilityId_dedupeKey_key" ON "IntegrationAlert"("facilityId", "dedupeKey");

-- CreateIndex
CREATE INDEX "IntegrationAlert_facilityId_status_severity_idx" ON "IntegrationAlert"("facilityId", "status", "severity");

-- CreateIndex
CREATE INDEX "IntegrationAlert_facilityId_system_idx" ON "IntegrationAlert"("facilityId", "system");
