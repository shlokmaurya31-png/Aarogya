-- Week 5b follow-up: a guardian decides a managed minor's processing and AI
-- consents (docs/HOUSEHOLD_DESIGN.md §14). Additive: every existing consent
-- was the person's own (SELF, the column default); a new table for the
-- pending parental-consent checks.
-- CreateEnum
CREATE TYPE "PersonConsentDecider" AS ENUM ('SELF', 'GUARDIAN');

-- AlterTable
ALTER TABLE "PersonConsent" ADD COLUMN     "decidedAs" "PersonConsentDecider" NOT NULL DEFAULT 'SELF',
ADD COLUMN     "guardianCheckId" TEXT;

-- CreateTable
CREATE TABLE "GuardianConsentCheck" (
    "id" TEXT NOT NULL,
    "minorPersonId" TEXT NOT NULL,
    "guardianPersonId" TEXT NOT NULL,
    "guardianUserId" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "purpose" "PersonConsentPurpose" NOT NULL,
    "decision" "PersonConsentDecision" NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "relationship" TEXT NOT NULL,
    "declarationText" TEXT NOT NULL,
    "phoneLast4" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "codeExpiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "confirmedAt" TIMESTAMP(3),
    "consentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuardianConsentCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GuardianConsentCheck_minorPersonId_idx" ON "GuardianConsentCheck"("minorPersonId");

-- CreateIndex
CREATE INDEX "GuardianConsentCheck_guardianPersonId_idx" ON "GuardianConsentCheck"("guardianPersonId");
