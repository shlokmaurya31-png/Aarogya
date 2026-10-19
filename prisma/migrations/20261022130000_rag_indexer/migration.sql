-- Week 4b, RAG step 6: the rag-indexer's backfill cursor, and consents that
-- lapse at 18 (docs/RAG_DESIGN.md §5.7, §11.3). Additive: no existing row
-- changes; a consent lapses only when the runner's sweep finds the person
-- turned 18 after deciding it.

-- AlterEnum
ALTER TYPE "PersonConsentStatus" ADD VALUE 'LAPSED';

-- AlterTable
ALTER TABLE "PersonConsent" ADD COLUMN     "lapsedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "RagBackfillCursor" (
    "facilityId" TEXT NOT NULL,
    "sourceType" "RagSourceType" NOT NULL,
    "lastSourceId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RagBackfillCursor_pkey" PRIMARY KEY ("facilityId","sourceType")
);


-- A lapsed consent says when.
ALTER TABLE "PersonConsent" ADD CONSTRAINT "PersonConsent_lapsed_check" CHECK (("status"::text = 'LAPSED') = ("lapsedAt" IS NOT NULL));
