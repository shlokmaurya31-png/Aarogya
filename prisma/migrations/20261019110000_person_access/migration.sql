-- Phase 0, part 1 (b): what personAccess() decides from. The person's
-- upload-sharing choice (append-only, at most one ACTIVE per purpose; no row
-- means not chosen = no), the owning Person of a patient upload, and the
-- pre-Phase-0 visibility flag. Additive: every existing upload keeps
-- personId NULL (the pre-Phase-0 rule) until the identity migration moves it.

-- CreateEnum
CREATE TYPE "PersonConsentPurpose" AS ENUM ('SHARE_UPLOADS_WITH_TREATING');
-- CreateEnum
CREATE TYPE "PersonConsentDecision" AS ENUM ('GRANTED', 'DECLINED');
-- CreateEnum
CREATE TYPE "PersonConsentStatus" AS ENUM ('ACTIVE', 'SUPERSEDED');
-- AlterTable
ALTER TABLE "ClinicalDocument" ADD COLUMN     "legacyFacilityVisible" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "personId" TEXT;
-- CreateTable
CREATE TABLE "PersonConsent" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "purpose" "PersonConsentPurpose" NOT NULL,
    "decision" "PersonConsentDecision" NOT NULL,
    "status" "PersonConsentStatus" NOT NULL DEFAULT 'ACTIVE',
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedByUserId" TEXT NOT NULL,
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PersonConsent_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "PersonConsent_personId_purpose_status_idx" ON "PersonConsent"("personId", "purpose", "status");
-- AddForeignKey
ALTER TABLE "ClinicalDocument" ADD CONSTRAINT "ClinicalDocument_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "PersonConsent" ADD CONSTRAINT "PersonConsent_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One current choice per purpose.
CREATE UNIQUE INDEX "PersonConsent_one_active_per_purpose" ON "PersonConsent"("personId", "purpose") WHERE "status" = 'ACTIVE';
-- A superseded choice says when.
ALTER TABLE "PersonConsent" ADD CONSTRAINT "PersonConsent_superseded_check"
  CHECK (("status" = 'SUPERSEDED') = ("supersededAt" IS NOT NULL));
-- Only a patient upload has an owning Person or the legacy flag.
ALTER TABLE "ClinicalDocument" ADD CONSTRAINT "ClinicalDocument_person_upload_check"
  CHECK (("personId" IS NULL AND "legacyFacilityVisible" = false) OR "uploadedByUserId" IS NOT NULL);
