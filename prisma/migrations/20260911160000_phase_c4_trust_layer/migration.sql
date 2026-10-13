-- Phase C4 — health data trust layer (PostgreSQL).
-- Mirrors prisma/migrations/20260911160000_phase_c4_trust_layer.
--
-- Fully ADDITIVE: two new tables plus one nullable-with-default column on
-- User. Nothing is dropped or retyped and no row is touched.
--
-- The SQLite mirror of this migration contains a DROP TABLE "User" — that is
-- Prisma rebuilding the table because SQLite cannot ADD COLUMN with a default
-- in place, and it copies every row first. PostgreSQL supports ALTER TABLE
-- directly, which is why this side is a simple ADD COLUMN.
--
-- User.tokenVersion is the session revocation mechanism: sessions are
-- stateless HMAC cookies carrying the version they were minted at, and
-- requireSession refuses a mismatch. Bumping it invalidates every cookie held
-- by that user. See src/lib/auth/authorize/sessionControl.ts.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "tokenVersion" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "BreakGlassAccess" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT,
    "actorUserId" TEXT NOT NULL,
    "actorStaffId" TEXT,
    "reason" TEXT NOT NULL,
    "emergencyContext" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,
    "revokedReason" TEXT,
    "correlationId" TEXT NOT NULL,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BreakGlassAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrivacyRequest" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "requestType" TEXT NOT NULL,
    "requesterType" TEXT NOT NULL,
    "requesterUserId" TEXT,
    "scope" TEXT,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "actionedAt" TIMESTAMP(3),
    "actionedByUserId" TEXT,
    "legalHold" BOOLEAN NOT NULL DEFAULT false,
    "legalHoldReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrivacyRequest_pkey" PRIMARY KEY ("id")
);

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
