-- RAG Phase 1: knowledge documents (docs/RAG_ARCHITECTURE.md §8; ADR 0005
-- part B). New tables only; nothing existing changes.

CREATE TYPE "KnowledgeDocumentType" AS ENUM ('SOP', 'POLICY', 'CLINICAL_REFERENCE', 'FORMULARY', 'ADMIN', 'EDUCATIONAL');
CREATE TYPE "KnowledgeAccessClass" AS ENUM ('ALL_STAFF', 'CLINICAL', 'PHARMACY', 'BILLING', 'ADMIN');
CREATE TYPE "KnowledgeApprovalStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED');
CREATE TYPE "KnowledgeIngestionStatus" AS ENUM ('RECEIVED', 'PARSING', 'CHUNKING', 'EMBEDDING', 'INDEXED', 'FAILED');
CREATE TYPE "KnowledgeScanStatus" AS ENUM ('NOT_SCANNED', 'CLEAN', 'INFECTED');

CREATE TABLE "KnowledgeDocument" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "facilityId" TEXT,
    "type" "KnowledgeDocumentType" NOT NULL,
    "accessClass" "KnowledgeAccessClass" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "ownerUserId" TEXT NOT NULL,
    "currentVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeDocument_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "KnowledgeDocumentVersion" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "storageRef" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "byteSize" INTEGER NOT NULL,
    "pageCount" INTEGER,
    "uploadedByUserId" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvalStatus" "KnowledgeApprovalStatus" NOT NULL DEFAULT 'DRAFT',
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedReason" TEXT,
    "effectiveAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "supersededByVersionId" TEXT,
    "withdrawnAt" TIMESTAMP(3),
    "ingestionStatus" "KnowledgeIngestionStatus" NOT NULL DEFAULT 'RECEIVED',
    "ingestionAttempts" INTEGER NOT NULL DEFAULT 0,
    "ingestionError" TEXT,
    "scanStatus" "KnowledgeScanStatus" NOT NULL DEFAULT 'NOT_SCANNED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeDocumentVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "KnowledgeDocument_currentVersionId_key" ON "KnowledgeDocument"("currentVersionId");
CREATE INDEX "KnowledgeDocument_organizationId_facilityId_idx" ON "KnowledgeDocument"("organizationId", "facilityId");
CREATE UNIQUE INDEX "KnowledgeDocumentVersion_supersededByVersionId_key" ON "KnowledgeDocumentVersion"("supersededByVersionId");
CREATE INDEX "KnowledgeDocumentVersion_approvalStatus_effectiveAt_idx" ON "KnowledgeDocumentVersion"("approvalStatus", "effectiveAt");
CREATE INDEX "KnowledgeDocumentVersion_ingestionStatus_idx" ON "KnowledgeDocumentVersion"("ingestionStatus");
CREATE UNIQUE INDEX "KnowledgeDocumentVersion_documentId_version_key" ON "KnowledgeDocumentVersion"("documentId", "version");
-- The same bytes twice for one document are refused as a duplicate.
CREATE UNIQUE INDEX "KnowledgeDocumentVersion_documentId_sha256_key" ON "KnowledgeDocumentVersion"("documentId", "sha256");

ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- RESTRICT, never SET NULL: a facility's document must not become organisation-wide by a delete.
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "KnowledgeDocumentVersion" ADD CONSTRAINT "KnowledgeDocumentVersion_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "KnowledgeDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A facility's document belongs to that facility's organisation.
CREATE FUNCTION "KnowledgeDocument_facility_org_check"() RETURNS trigger AS $$
BEGIN
  IF NEW."facilityId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Facility" WHERE "id" = NEW."facilityId" AND "organizationId" = NEW."organizationId") THEN
    RAISE EXCEPTION 'KnowledgeDocument: the facility is not in the organisation' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "KnowledgeDocument_facility_org_check_trg" BEFORE INSERT OR UPDATE OF "facilityId", "organizationId" ON "KnowledgeDocument"
  FOR EACH ROW EXECUTE FUNCTION "KnowledgeDocument_facility_org_check"();

ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_title_check" CHECK (length(btrim("title")) >= 1);
ALTER TABLE "KnowledgeDocumentVersion" ADD CONSTRAINT "KnowledgeDocumentVersion_version_check" CHECK ("version" >= 1);
ALTER TABLE "KnowledgeDocumentVersion" ADD CONSTRAINT "KnowledgeDocumentVersion_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "KnowledgeDocumentVersion" ADD CONSTRAINT "KnowledgeDocumentVersion_size_check" CHECK ("byteSize" > 0 AND ("pageCount" IS NULL OR "pageCount" >= 1));
-- Decided 2026-11-17: the approver can never be the uploader.
ALTER TABLE "KnowledgeDocumentVersion" ADD CONSTRAINT "KnowledgeDocumentVersion_approver_check" CHECK ("approvedByUserId" IS NULL OR "approvedByUserId" <> "uploadedByUserId");
-- An approval names its approver and time; only an approved version is ever published.
ALTER TABLE "KnowledgeDocumentVersion" ADD CONSTRAINT "KnowledgeDocumentVersion_approval_check" CHECK (
  ("approvalStatus" = 'APPROVED') = ("approvedByUserId" IS NOT NULL AND "approvedAt" IS NOT NULL)
);
ALTER TABLE "KnowledgeDocumentVersion" ADD CONSTRAINT "KnowledgeDocumentVersion_published_check" CHECK ("publishedAt" IS NULL OR "approvalStatus" = 'APPROVED');
ALTER TABLE "KnowledgeDocumentVersion" ADD CONSTRAINT "KnowledgeDocumentVersion_rejected_check" CHECK ("approvalStatus" <> 'REJECTED' OR length(btrim(coalesce("rejectedReason", ''))) >= 3);
ALTER TABLE "KnowledgeDocumentVersion" ADD CONSTRAINT "KnowledgeDocumentVersion_window_check" CHECK ("effectiveAt" IS NULL OR "expiresAt" IS NULL OR "effectiveAt" < "expiresAt");
ALTER TABLE "KnowledgeDocumentVersion" ADD CONSTRAINT "KnowledgeDocumentVersion_failed_check" CHECK (("ingestionStatus" = 'FAILED') = ("ingestionError" IS NOT NULL));
ALTER TABLE "KnowledgeDocumentVersion" ADD CONSTRAINT "KnowledgeDocumentVersion_superseded_check" CHECK ("supersededByVersionId" IS NULL OR "supersededByVersionId" <> "id");
