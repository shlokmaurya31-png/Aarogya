-- Phase D11 — Patient Experience: family / caregiver delegated access (PostgreSQL).
-- Mirrors prisma/migrations/20260920144540_phase_d11_patient_delegation.
--
-- Strictly additive: two new tables (delegation + its scope child). No DROP,
-- no retype, no enum, no data change. status/relationship/scope are TEXT
-- (values enforced in code), per the D5–D10 convention. Every clinical,
-- financial and interoperability fact stays in its canonical table; this is
-- the only persistence D11 introduces.

-- CreateTable
CREATE TABLE "PatientDelegation" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "delegateUserId" TEXT,
    "relationship" TEXT NOT NULL,
    "purpose" TEXT,
    "status" TEXT NOT NULL DEFAULT 'INVITED',
    "inviteTokenHash" TEXT,
    "invitedContact" TEXT,
    "invitedName" TEXT,
    "inviteExpiresAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "createdByUserId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PatientDelegation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientDelegationScope" (
    "id" TEXT NOT NULL,
    "delegationId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PatientDelegationScope_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PatientDelegation_inviteTokenHash_key" ON "PatientDelegation"("inviteTokenHash");
CREATE INDEX "PatientDelegation_patientId_status_idx" ON "PatientDelegation"("patientId", "status");
CREATE INDEX "PatientDelegation_delegateUserId_status_idx" ON "PatientDelegation"("delegateUserId", "status");
CREATE INDEX "PatientDelegation_expiresAt_idx" ON "PatientDelegation"("expiresAt");
CREATE INDEX "PatientDelegationScope_delegationId_idx" ON "PatientDelegationScope"("delegationId");
CREATE UNIQUE INDEX "PatientDelegationScope_delegationId_scope_key" ON "PatientDelegationScope"("delegationId", "scope");

-- AddForeignKey
ALTER TABLE "PatientDelegation" ADD CONSTRAINT "PatientDelegation_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PatientDelegation" ADD CONSTRAINT "PatientDelegation_delegateUserId_fkey" FOREIGN KEY ("delegateUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PatientDelegationScope" ADD CONSTRAINT "PatientDelegationScope_delegationId_fkey" FOREIGN KEY ("delegationId") REFERENCES "PatientDelegation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
