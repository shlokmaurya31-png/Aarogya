-- Phase D1 — enterprise tenancy (PostgreSQL).
-- Mirrors prisma/migrations/20260913202108_phase_d1_enterprise_tenancy.
--
-- Strictly additive. Five new tables, plus nullable/defaulted columns on the
-- existing Organization, Facility and AuditEvent. No DROP, no DELETE, no
-- TRUNCATE, no retype. Unlike the SQLite tree (which rebuilds a table to add a
-- column) PostgreSQL adds columns in place, so no existing row is rewritten.
--
-- Every index/constraint name below is under PostgreSQL's 63-character
-- identifier limit (longest: OrganizationMembership_userId_organizationId_key,
-- 48 chars) so this tree cannot silently drift from the SQLite one.
--
-- Foreign keys are declared after every table exists so a replay from zero
-- never references a table that has not yet been created.
-- The backfill at the end is deterministic and idempotent (ON CONFLICT DO
-- NOTHING) and creates no ownership that did not already exist.

-- AlterTable — Organization lifecycle.
ALTER TABLE "Organization" ADD COLUMN     "slug" TEXT,
ADD COLUMN     "legalName" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "suspendedAt" TIMESTAMP(3),
ADD COLUMN     "deactivatedAt" TIMESTAMP(3);

-- AlterTable — Facility lifecycle.
ALTER TABLE "Facility" ADD COLUMN     "slug" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "suspendedAt" TIMESTAMP(3),
ADD COLUMN     "deactivatedAt" TIMESTAMP(3);

-- AlterTable — AuditEvent organization scope.
ALTER TABLE "AuditEvent" ADD COLUMN     "organizationId" TEXT;

-- CreateTable
CREATE TABLE "OrganizationMembership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FacilityMembership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FacilityMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgConfigValue" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrgConfigValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FacilityConfigValue" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FacilityConfigValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepartmentConfigValue" (
    "id" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DepartmentConfigValue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");
CREATE INDEX "Organization_status_idx" ON "Organization"("status");
CREATE INDEX "Facility_organizationId_idx" ON "Facility"("organizationId");
CREATE INDEX "Facility_status_idx" ON "Facility"("status");
CREATE UNIQUE INDEX "Facility_organizationId_slug_key" ON "Facility"("organizationId", "slug");
CREATE INDEX "AuditEvent_organizationId_idx" ON "AuditEvent"("organizationId");
CREATE INDEX "OrganizationMembership_organizationId_idx" ON "OrganizationMembership"("organizationId");
CREATE INDEX "OrganizationMembership_userId_idx" ON "OrganizationMembership"("userId");
CREATE UNIQUE INDEX "OrganizationMembership_userId_organizationId_key" ON "OrganizationMembership"("userId", "organizationId");
CREATE INDEX "FacilityMembership_facilityId_idx" ON "FacilityMembership"("facilityId");
CREATE INDEX "FacilityMembership_userId_idx" ON "FacilityMembership"("userId");
CREATE UNIQUE INDEX "FacilityMembership_userId_facilityId_key" ON "FacilityMembership"("userId", "facilityId");
CREATE INDEX "OrgConfigValue_organizationId_idx" ON "OrgConfigValue"("organizationId");
CREATE UNIQUE INDEX "OrgConfigValue_organizationId_key_key" ON "OrgConfigValue"("organizationId", "key");
CREATE INDEX "FacilityConfigValue_facilityId_idx" ON "FacilityConfigValue"("facilityId");
CREATE UNIQUE INDEX "FacilityConfigValue_facilityId_key_key" ON "FacilityConfigValue"("facilityId", "key");
CREATE INDEX "DepartmentConfigValue_departmentId_idx" ON "DepartmentConfigValue"("departmentId");
CREATE UNIQUE INDEX "DepartmentConfigValue_departmentId_key_key" ON "DepartmentConfigValue"("departmentId", "key");

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OrganizationMembership" ADD CONSTRAINT "OrganizationMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrganizationMembership" ADD CONSTRAINT "OrganizationMembership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FacilityMembership" ADD CONSTRAINT "FacilityMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FacilityMembership" ADD CONSTRAINT "FacilityMembership_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrgConfigValue" ADD CONSTRAINT "OrgConfigValue_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FacilityConfigValue" ADD CONSTRAINT "FacilityConfigValue_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DepartmentConfigValue" ADD CONSTRAINT "DepartmentConfigValue_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- Phase D1 — deterministic, idempotent backfill (mirrors the SQLite tree).
-- Creates no ownership that did not already exist: it makes each staff
-- member's existing single-facility access explicit in the membership model.
-- Organization administration is NOT backfilled — deny by default.
-- ─────────────────────────────────────────────────────────────────────────
UPDATE "Organization" SET "slug" = "id" WHERE "slug" IS NULL;
UPDATE "Facility" SET "slug" = "id" WHERE "slug" IS NULL;

INSERT INTO "FacilityMembership" ("id", "userId", "facilityId", "isAdmin", "status", "createdByUserId", "createdAt", "updatedAt")
SELECT
  'fm-' || hsp."userId" || '-' || hsp."facilityId",
  hsp."userId",
  hsp."facilityId",
  (u."role" = 'HOSPITAL_ADMIN'),
  'ACTIVE',
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "HospitalStaffProfile" hsp
JOIN "User" u ON u."id" = hsp."userId"
ON CONFLICT DO NOTHING;

INSERT INTO "OrganizationMembership" ("id", "userId", "organizationId", "isAdmin", "status", "createdByUserId", "createdAt", "updatedAt")
SELECT DISTINCT
  'om-' || hsp."userId" || '-' || f."organizationId",
  hsp."userId",
  f."organizationId",
  false,
  'ACTIVE',
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "HospitalStaffProfile" hsp
JOIN "Facility" f ON f."id" = hsp."facilityId"
ON CONFLICT DO NOTHING;
