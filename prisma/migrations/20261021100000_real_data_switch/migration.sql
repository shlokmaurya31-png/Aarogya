-- Week 4a, step 1: the real-data switch and its consent purposes. Every
-- facility and Person is REAL unless marked otherwise: nothing is assumed
-- synthetic (the seed marks its own demo facilities). New person-level consent
-- purposes DOCUMENT_PROCESSING, AI_ASSISTANCE and AI_TEXT_RETENTION (with
-- scopes, e.g. SAFETY_REVIEW). Additive.

CREATE TYPE "DataClassification" AS ENUM ('REAL', 'SYNTHETIC');
ALTER TYPE "PersonConsentPurpose" ADD VALUE 'DOCUMENT_PROCESSING';
ALTER TYPE "PersonConsentPurpose" ADD VALUE 'AI_ASSISTANCE';
ALTER TYPE "PersonConsentPurpose" ADD VALUE 'AI_TEXT_RETENTION';
ALTER TABLE "Facility" ADD COLUMN     "dataClassification" "DataClassification" NOT NULL DEFAULT 'REAL';
ALTER TABLE "Person" ADD COLUMN     "dataClassification" "DataClassification" NOT NULL DEFAULT 'REAL';
ALTER TABLE "PersonConsent" ADD COLUMN     "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Scopes belong to AI_TEXT_RETENTION only, and only SAFETY_REVIEW exists.
ALTER TABLE "PersonConsent" ADD CONSTRAINT "PersonConsent_scopes_check"
  CHECK (cardinality("scopes") = 0 OR ("purpose"::text = 'AI_TEXT_RETENTION' AND "scopes" <@ ARRAY['SAFETY_REVIEW']::text[]));
