-- CreateTable
CREATE TABLE "PatientDelegation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "patientId" TEXT NOT NULL,
    "delegateUserId" TEXT,
    "relationship" TEXT NOT NULL,
    "purpose" TEXT,
    "status" TEXT NOT NULL DEFAULT 'INVITED',
    "inviteTokenHash" TEXT,
    "invitedContact" TEXT,
    "invitedName" TEXT,
    "inviteExpiresAt" DATETIME,
    "acceptedAt" DATETIME,
    "expiresAt" DATETIME,
    "revokedAt" DATETIME,
    "revokedReason" TEXT,
    "createdByUserId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PatientDelegation_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PatientDelegation_delegateUserId_fkey" FOREIGN KEY ("delegateUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PatientDelegationScope" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "delegationId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PatientDelegationScope_delegationId_fkey" FOREIGN KEY ("delegationId") REFERENCES "PatientDelegation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "PatientDelegation_inviteTokenHash_key" ON "PatientDelegation"("inviteTokenHash");

-- CreateIndex
CREATE INDEX "PatientDelegation_patientId_status_idx" ON "PatientDelegation"("patientId", "status");

-- CreateIndex
CREATE INDEX "PatientDelegation_delegateUserId_status_idx" ON "PatientDelegation"("delegateUserId", "status");

-- CreateIndex
CREATE INDEX "PatientDelegation_expiresAt_idx" ON "PatientDelegation"("expiresAt");

-- CreateIndex
CREATE INDEX "PatientDelegationScope_delegationId_idx" ON "PatientDelegationScope"("delegationId");

-- CreateIndex
CREATE UNIQUE INDEX "PatientDelegationScope_delegationId_scope_key" ON "PatientDelegationScope"("delegationId", "scope");
