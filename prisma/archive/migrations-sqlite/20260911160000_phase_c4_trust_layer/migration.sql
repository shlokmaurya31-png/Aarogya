-- Phase C4 — health data trust layer (SQLite).
--
-- Adds BreakGlassAccess, PrivacyRequest and User.tokenVersion.
--
-- NOTE ON THE "DROP TABLE User" BELOW: this is NOT destructive. It is Prisma's
-- standard SQLite table-rebuild for adding a column with a default, and the
-- INSERT...SELECT immediately above it copies every existing row into the new
-- table before the old one is dropped and the new one renamed. Every existing
-- column is carried across. SQLite cannot ALTER a table in place the way
-- PostgreSQL can, which is why the PostgreSQL baseline for this same migration
-- is a plain ALTER TABLE ADD COLUMN. Same pattern as the B5/B6/B7 migrations.

-- CreateTable
CREATE TABLE "BreakGlassAccess" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT,
    "actorUserId" TEXT NOT NULL,
    "actorStaffId" TEXT,
    "reason" TEXT NOT NULL,
    "emergencyContext" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "activatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "completedAt" DATETIME,
    "revokedAt" DATETIME,
    "revokedByUserId" TEXT,
    "revokedReason" TEXT,
    "correlationId" TEXT NOT NULL,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PrivacyRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "requestType" TEXT NOT NULL,
    "requesterType" TEXT NOT NULL,
    "requesterUserId" TEXT,
    "scope" TEXT,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "reviewedByUserId" TEXT,
    "reviewedAt" DATETIME,
    "decisionNote" TEXT,
    "actionedAt" DATETIME,
    "actionedByUserId" TEXT,
    "legalHold" BOOLEAN NOT NULL DEFAULT false,
    "legalHoldReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "role" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_User" ("createdAt", "displayName", "email", "id", "passwordHash", "role", "updatedAt") SELECT "createdAt", "displayName", "email", "id", "passwordHash", "role", "updatedAt" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE INDEX "User_role_idx" ON "User"("role");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "BreakGlassAccess_facilityId_status_idx" ON "BreakGlassAccess"("facilityId", "status");

-- CreateIndex
CREATE INDEX "BreakGlassAccess_facilityId_patientId_idx" ON "BreakGlassAccess"("facilityId", "patientId");

-- CreateIndex
CREATE INDEX "BreakGlassAccess_actorUserId_idx" ON "BreakGlassAccess"("actorUserId");

-- CreateIndex
CREATE INDEX "BreakGlassAccess_expiresAt_idx" ON "BreakGlassAccess"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "BreakGlassAccess_correlationId_key" ON "BreakGlassAccess"("correlationId");

-- CreateIndex
CREATE INDEX "PrivacyRequest_facilityId_status_idx" ON "PrivacyRequest"("facilityId", "status");

-- CreateIndex
CREATE INDEX "PrivacyRequest_facilityId_patientId_idx" ON "PrivacyRequest"("facilityId", "patientId");
