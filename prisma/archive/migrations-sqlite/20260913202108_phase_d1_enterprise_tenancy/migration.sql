-- CreateTable
CREATE TABLE "OrganizationMembership" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdByUserId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrganizationMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "OrganizationMembership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FacilityMembership" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdByUserId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FacilityMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "FacilityMembership_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OrgConfigValue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedByUserId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrgConfigValue_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FacilityConfigValue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedByUserId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FacilityConfigValue_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DepartmentConfigValue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "departmentId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedByUserId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DepartmentConfigValue_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AuditEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "userId" TEXT,
    "detail" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "facilityId" TEXT,
    "patientId" TEXT,
    "encounterId" TEXT,
    "organizationId" TEXT,
    CONSTRAINT "AuditEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AuditEvent_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AuditEvent_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AuditEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_AuditEvent" ("createdAt", "detail", "encounterId", "facilityId", "id", "patientId", "type", "userId") SELECT "createdAt", "detail", "encounterId", "facilityId", "id", "patientId", "type", "userId" FROM "AuditEvent";
DROP TABLE "AuditEvent";
ALTER TABLE "new_AuditEvent" RENAME TO "AuditEvent";
CREATE INDEX "AuditEvent_type_idx" ON "AuditEvent"("type");
CREATE INDEX "AuditEvent_userId_idx" ON "AuditEvent"("userId");
CREATE INDEX "AuditEvent_facilityId_idx" ON "AuditEvent"("facilityId");
CREATE INDEX "AuditEvent_patientId_idx" ON "AuditEvent"("patientId");
CREATE INDEX "AuditEvent_encounterId_idx" ON "AuditEvent"("encounterId");
CREATE INDEX "AuditEvent_organizationId_idx" ON "AuditEvent"("organizationId");
CREATE TABLE "new_Facility" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "city" TEXT,
    "slug" TEXT,
    "organizationId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "suspendedAt" DATETIME,
    "deactivatedAt" DATETIME,
    CONSTRAINT "Facility_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Facility" ("city", "createdAt", "id", "name", "organizationId") SELECT "city", "createdAt", "id", "name", "organizationId" FROM "Facility";
DROP TABLE "Facility";
ALTER TABLE "new_Facility" RENAME TO "Facility";
CREATE INDEX "Facility_organizationId_idx" ON "Facility"("organizationId");
CREATE INDEX "Facility_status_idx" ON "Facility"("status");
CREATE UNIQUE INDEX "Facility_organizationId_slug_key" ON "Facility"("organizationId", "slug");
CREATE TABLE "new_Organization" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT,
    "name" TEXT NOT NULL,
    "legalName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "suspendedAt" DATETIME,
    "deactivatedAt" DATETIME
);
INSERT INTO "new_Organization" ("createdAt", "id", "name") SELECT "createdAt", "id", "name" FROM "Organization";
DROP TABLE "Organization";
ALTER TABLE "new_Organization" RENAME TO "Organization";
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");
CREATE INDEX "Organization_status_idx" ON "Organization"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "OrganizationMembership_organizationId_idx" ON "OrganizationMembership"("organizationId");

-- CreateIndex
CREATE INDEX "OrganizationMembership_userId_idx" ON "OrganizationMembership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMembership_userId_organizationId_key" ON "OrganizationMembership"("userId", "organizationId");

-- CreateIndex
CREATE INDEX "FacilityMembership_facilityId_idx" ON "FacilityMembership"("facilityId");

-- CreateIndex
CREATE INDEX "FacilityMembership_userId_idx" ON "FacilityMembership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "FacilityMembership_userId_facilityId_key" ON "FacilityMembership"("userId", "facilityId");

-- CreateIndex
CREATE INDEX "OrgConfigValue_organizationId_idx" ON "OrgConfigValue"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "OrgConfigValue_organizationId_key_key" ON "OrgConfigValue"("organizationId", "key");

-- CreateIndex
CREATE INDEX "FacilityConfigValue_facilityId_idx" ON "FacilityConfigValue"("facilityId");

-- CreateIndex
CREATE UNIQUE INDEX "FacilityConfigValue_facilityId_key_key" ON "FacilityConfigValue"("facilityId", "key");

-- CreateIndex
CREATE INDEX "DepartmentConfigValue_departmentId_idx" ON "DepartmentConfigValue"("departmentId");

-- CreateIndex
CREATE UNIQUE INDEX "DepartmentConfigValue_departmentId_key_key" ON "DepartmentConfigValue"("departmentId", "key");

-- ─────────────────────────────────────────────────────────────────────────
-- Phase D1 — deterministic, idempotent backfill.
--
-- No row is created, deleted or retyped destructively above; the table
-- rebuilds are SQLite's mechanism for ADD COLUMN and preserve every row via
-- INSERT ... SELECT. This block makes the existing single-tenant deployment a
-- valid multi-tenant one WITHOUT fabricating ownership:
--
--   1. Every existing organization/facility keeps its opaque id AND gains a
--      stable slug equal to that id (deterministic, collision-free, reversible).
--   2. Every existing staff member gains an explicit FacilityMembership for the
--      facility they already work at, and an OrganizationMembership for that
--      facility's organization. This does not GRANT new access — the staff
--      member already had exactly that facility via HospitalStaffProfile — it
--      makes the existing access explicit in the new membership model.
--   3. A facility-admin (User.role = 'HOSPITAL_ADMIN') is recorded as the
--      facility administrator (isAdmin = 1). Organization administration is a
--      deliberately explicit, separate grant and is NOT backfilled: deny by
--      default (a facility admin is not automatically an organization admin).
--
-- Deterministic ids ('om-'/'fm-' + user + scope) + INSERT OR IGNORE make this
-- safe to replay. To reverse: DELETE the 'om-%'/'fm-%' rows and NULL the slugs.
-- ─────────────────────────────────────────────────────────────────────────

-- 1. Stable slugs for existing tenants (idempotent: only fills NULLs).
UPDATE "Organization" SET "slug" = "id" WHERE "slug" IS NULL;
UPDATE "Facility" SET "slug" = "id" WHERE "slug" IS NULL;

-- 2. Facility membership for every existing staff profile.
INSERT OR IGNORE INTO "FacilityMembership" ("id", "userId", "facilityId", "isAdmin", "status", "createdByUserId", "createdAt", "updatedAt")
SELECT
  'fm-' || hsp."userId" || '-' || hsp."facilityId",
  hsp."userId",
  hsp."facilityId",
  CASE WHEN u."role" = 'HOSPITAL_ADMIN' THEN 1 ELSE 0 END,
  'ACTIVE',
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "HospitalStaffProfile" hsp
JOIN "User" u ON u."id" = hsp."userId";

-- 3. Organization membership for every (staff user, their facility's org).
--    Organization admin is NOT backfilled (isAdmin = 0) — it is an explicit grant.
INSERT OR IGNORE INTO "OrganizationMembership" ("id", "userId", "organizationId", "isAdmin", "status", "createdByUserId", "createdAt", "updatedAt")
SELECT DISTINCT
  'om-' || hsp."userId" || '-' || f."organizationId",
  hsp."userId",
  f."organizationId",
  0,
  'ACTIVE',
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "HospitalStaffProfile" hsp
JOIN "Facility" f ON f."id" = hsp."facilityId";
