-- RAG Phase 2: what ingestion records about a knowledge version (docs/RAG_IMPLEMENTATION_PLAN.md §4).
-- Additive: new nullable or defaulted columns; new CHECKs added NOT VALID and
-- then validated, so an existing row that breaks one stops this migration
-- with the constraint's name. Nothing is repaired or guessed.

ALTER TABLE "KnowledgeDocumentVersion" ADD COLUMN "fileName" TEXT,
ADD COLUMN "format" TEXT,
ADD COLUMN "chunkCount" INTEGER,
ADD COLUMN "cacheHitCount" INTEGER,
ADD COLUMN "embeddedCount" INTEGER,
ADD COLUMN "ingestionStartedAt" TIMESTAMP(3),
ADD COLUMN "indexedAt" TIMESTAMP(3),
ADD COLUMN "submittedAt" TIMESTAMP(3);

ALTER TABLE "KnowledgeDocumentVersion" ADD CONSTRAINT "KnowledgeDocumentVersion_format_check"
  CHECK ("format" IS NULL OR "format" IN ('PDF', 'TEXT', 'MARKDOWN', 'HTML', 'CSV', 'JSON')) NOT VALID;
ALTER TABLE "KnowledgeDocumentVersion" ADD CONSTRAINT "KnowledgeDocumentVersion_counts_check"
  CHECK (coalesce("chunkCount", 0) >= 0 AND coalesce("cacheHitCount", 0) >= 0 AND coalesce("embeddedCount", 0) >= 0) NOT VALID;
-- An indexed version says when and how much; nothing else claims to be indexed.
ALTER TABLE "KnowledgeDocumentVersion" ADD CONSTRAINT "KnowledgeDocumentVersion_indexed_check"
  CHECK (("ingestionStatus" = 'INDEXED') = ("indexedAt" IS NOT NULL AND "chunkCount" IS NOT NULL)) NOT VALID;
-- Only an indexed version can be approved or published: an approver approves what will be searched.
ALTER TABLE "KnowledgeDocumentVersion" ADD CONSTRAINT "KnowledgeDocumentVersion_approve_indexed_check"
  CHECK ("approvalStatus" <> 'APPROVED' OR "ingestionStatus" = 'INDEXED') NOT VALID;
-- A version that was superseded or withdrawn is never published again.
ALTER TABLE "KnowledgeDocumentVersion" ADD CONSTRAINT "KnowledgeDocumentVersion_retired_check"
  CHECK ("supersededByVersionId" IS NULL OR "publishedAt" IS NOT NULL) NOT VALID;

ALTER TABLE "KnowledgeDocumentVersion" VALIDATE CONSTRAINT "KnowledgeDocumentVersion_format_check";
ALTER TABLE "KnowledgeDocumentVersion" VALIDATE CONSTRAINT "KnowledgeDocumentVersion_counts_check";
ALTER TABLE "KnowledgeDocumentVersion" VALIDATE CONSTRAINT "KnowledgeDocumentVersion_indexed_check";
ALTER TABLE "KnowledgeDocumentVersion" VALIDATE CONSTRAINT "KnowledgeDocumentVersion_approve_indexed_check";
ALTER TABLE "KnowledgeDocumentVersion" VALIDATE CONSTRAINT "KnowledgeDocumentVersion_retired_check";

-- The runner's publish and expiry sweeps, and the admin view's status filter.
CREATE INDEX "KnowledgeDocumentVersion_documentId_approvalStatus_idx" ON "KnowledgeDocumentVersion"("documentId", "approvalStatus");
CREATE INDEX "KnowledgeDocumentVersion_expiresAt_idx" ON "KnowledgeDocumentVersion"("expiresAt");
