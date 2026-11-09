-- Flagship 4e: offline mode per ward, off until a hospital admin turns it on,
-- and the clinical advisor's sign-off it needs. Additive: every existing ward
-- starts with offline mode OFF (the safe default; nothing can lose it).

ALTER TABLE "Ward" ADD COLUMN     "offlineEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "offlineEnabledAt" TIMESTAMP(3),
ADD COLUMN     "offlineEnabledByUserId" TEXT;

-- CreateTable
CREATE TABLE "ClinicalSignOff" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "advisorName" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "signedOffAt" TIMESTAMP(3) NOT NULL,
    "recordedByUserId" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,
    "revokeReason" TEXT,

    CONSTRAINT "ClinicalSignOff_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ClinicalSignOff_revoked" CHECK ("revokedAt" IS NULL OR ("revokedByUserId" IS NOT NULL AND "revokeReason" IS NOT NULL))
);

-- CreateIndex
CREATE INDEX "ClinicalSignOff_scope_idx" ON "ClinicalSignOff"("scope");

-- One active sign-off per scope.
CREATE UNIQUE INDEX "ClinicalSignOff_one_active" ON "ClinicalSignOff"("scope") WHERE "revokedAt" IS NULL;
