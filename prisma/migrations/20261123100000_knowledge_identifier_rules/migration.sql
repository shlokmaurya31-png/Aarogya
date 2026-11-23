-- Decisions before Phase 3 (docs/RAG_IMPLEMENTATION_PLAN.md §13.4 B and C):
--   B  an administrator may re-propose an older version: the same file as a new
--      version number, under the same two-person approval;
--   C  numbers highlighted for the approver (12-digit numbers that fail the
--      Aadhaar checksum; mobiles not on the facility's published contact list),
--      each acknowledged before approval; the facility's contact list.
-- Additive: new types, tables and defaulted columns. The one uniqueness rule
-- that changes, "the same bytes once per document", gains the re-proposal
-- number: every existing row has 0, so for them the rule is exactly the one
-- before. The new index is built before the old one is dropped, so the rule
-- holds throughout. New CHECKs are added NOT VALID, then validated: an
-- existing row that breaks one stops this migration with the constraint's
-- name. Nothing is repaired or guessed.

CREATE TYPE "KnowledgeHighlightKind" AS ENUM ('TWELVE_DIGIT_NUMBER', 'MOBILE_NUMBER');
CREATE TYPE "FacilityContactKind" AS ENUM ('SWITCHBOARD', 'HELPLINE', 'AMBULANCE', 'OTHER');

ALTER TABLE "KnowledgeDocumentVersion" ADD COLUMN "highlightCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "highlightsAcknowledgedAt" TIMESTAMP(3),
ADD COLUMN "reproposalSeq" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "reproposedFromVersionId" TEXT;

CREATE UNIQUE INDEX "KnowledgeDocumentVersion_documentId_sha256_reproposalSeq_key" ON "KnowledgeDocumentVersion"("documentId", "sha256", "reproposalSeq");
DROP INDEX "KnowledgeDocumentVersion_documentId_sha256_key";

-- A re-proposal names its source and has a number; an upload has neither.
ALTER TABLE "KnowledgeDocumentVersion" ADD CONSTRAINT "KnowledgeDocumentVersion_reproposal_check"
  CHECK (("reproposedFromVersionId" IS NULL) = ("reproposalSeq" = 0) AND "reproposalSeq" >= 0 AND ("reproposedFromVersionId" IS NULL OR "reproposedFromVersionId" <> "id")) NOT VALID;
-- A version with highlights is approved only once they were acknowledged.
ALTER TABLE "KnowledgeDocumentVersion" ADD CONSTRAINT "KnowledgeDocumentVersion_highlights_ack_check"
  CHECK ("highlightCount" >= 0 AND ("approvalStatus" <> 'APPROVED' OR "highlightCount" = 0 OR "highlightsAcknowledgedAt" IS NOT NULL)) NOT VALID;
ALTER TABLE "KnowledgeDocumentVersion" VALIDATE CONSTRAINT "KnowledgeDocumentVersion_reproposal_check";
ALTER TABLE "KnowledgeDocumentVersion" VALIDATE CONSTRAINT "KnowledgeDocumentVersion_highlights_ack_check";

CREATE TABLE "KnowledgeIdentifierHighlight" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "kind" "KnowledgeHighlightKind" NOT NULL,
    "location" TEXT NOT NULL,
    "pageNumber" INTEGER,
    "excerpt" TEXT NOT NULL,
    "acknowledgedByUserId" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeIdentifierHighlight_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "KnowledgeIdentifierHighlight_location_check" CHECK ("location" IN ('TEXT', 'DETAILS')),
    CONSTRAINT "KnowledgeIdentifierHighlight_ack_check" CHECK (("acknowledgedByUserId" IS NULL) = ("acknowledgedAt" IS NULL)),
    -- The excerpt never carries a run of seven or more digits: numbers are masked to their last four.
    CONSTRAINT "KnowledgeIdentifierHighlight_masked_check" CHECK ("excerpt" !~ '[0-9]{7}' AND char_length("excerpt") <= 400)
);
CREATE UNIQUE INDEX "KnowledgeIdentifierHighlight_versionId_ordinal_key" ON "KnowledgeIdentifierHighlight"("versionId", "ordinal");
ALTER TABLE "KnowledgeIdentifierHighlight" ADD CONSTRAINT "KnowledgeIdentifierHighlight_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "KnowledgeDocumentVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "FacilityPublishedContact" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "kind" "FacilityContactKind" NOT NULL,
    "label" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "addedByUserId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "removedByUserId" TEXT,

    CONSTRAINT "FacilityPublishedContact_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "FacilityPublishedContact_number_check" CHECK ("number" ~ '^[6-9][0-9]{9}$'),
    CONSTRAINT "FacilityPublishedContact_label_check" CHECK (char_length("label") BETWEEN 2 AND 80),
    CONSTRAINT "FacilityPublishedContact_removed_check" CHECK (("removedAt" IS NULL) = ("removedByUserId" IS NULL))
);
CREATE INDEX "FacilityPublishedContact_facilityId_removedAt_idx" ON "FacilityPublishedContact"("facilityId", "removedAt");
CREATE INDEX "FacilityPublishedContact_organizationId_idx" ON "FacilityPublishedContact"("organizationId");
ALTER TABLE "FacilityPublishedContact" ADD CONSTRAINT "FacilityPublishedContact_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
