-- Phase D8 — configuration engine (SQLite).
-- Strictly additive: two new tables (governed override store + immutable change
-- history) with their indexes. No change to any existing table (the D1
-- OrgConfigValue/FacilityConfigValue/DepartmentConfigValue KV is untouched).
-- Status/type fields are TEXT; allowed values enforced in code (src/lib/config/).

-- CreateTable
CREATE TABLE "ConfigurationOverride" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "valueType" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scopeRef" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "facilityId" TEXT,
    "departmentId" TEXT,
    "value" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 0,
    "effectiveFrom" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveUntil" DATETIME,
    "reason" TEXT,
    "createdByUserId" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ConfigurationChange" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "overrideId" TEXT,
    "key" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scopeRef" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "version" INTEGER,
    "actorUserId" TEXT,
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "ConfigurationOverride_scope_scopeRef_key_version_key" ON "ConfigurationOverride"("scope", "scopeRef", "key", "version");
CREATE INDEX "ConfigurationOverride_organizationId_idx" ON "ConfigurationOverride"("organizationId");
CREATE INDEX "ConfigurationOverride_scope_scopeRef_key_status_idx" ON "ConfigurationOverride"("scope", "scopeRef", "key", "status");
CREATE INDEX "ConfigurationOverride_key_status_idx" ON "ConfigurationOverride"("key", "status");
CREATE INDEX "ConfigurationOverride_status_effectiveFrom_idx" ON "ConfigurationOverride"("status", "effectiveFrom");

-- CreateIndex
CREATE INDEX "ConfigurationChange_organizationId_idx" ON "ConfigurationChange"("organizationId");
CREATE INDEX "ConfigurationChange_scope_scopeRef_key_idx" ON "ConfigurationChange"("scope", "scopeRef", "key");
CREATE INDEX "ConfigurationChange_createdAt_idx" ON "ConfigurationChange"("createdAt");
