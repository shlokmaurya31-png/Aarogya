-- RAG Phase 1: the index holds knowledge chunks (ownerType KNOWLEDGE) and
-- imported results (origin IMPORTED) beside the patient and person rows
-- (ADR 0005 part B). Additive: new nullable columns, replaced CHECKs that
-- every existing row already satisfies, the copy trigger extended.
--
-- Refuses rather than guesses: the new CHECKs are added NOT VALID and then
-- validated, so an existing row that breaks one stops this migration with
-- the constraint's name; nothing is repaired.

ALTER TABLE "RagDocument" ADD COLUMN "knowledgeVersionId" TEXT,
ADD COLUMN "accessClass" "KnowledgeAccessClass";

ALTER TABLE "RagChunk" ADD COLUMN "language" TEXT NOT NULL DEFAULT 'en',
ADD COLUMN "organizationId" TEXT,
ADD COLUMN "accessClass" "KnowledgeAccessClass",
ADD COLUMN "pageNumber" INTEGER,
ADD COLUMN "sectionPath" TEXT,
-- English stems only for an English chunk (PostgreSQL has no Indic dictionary; docs/RAG_ARCHITECTURE.md §10).
ADD COLUMN "tsvEnglish" tsvector GENERATED ALWAYS AS (
  CASE WHEN "language" = 'en' THEN to_tsvector('english', coalesce("context", '') || ' ' || coalesce("heading", '') || ' ' || "text") ELSE NULL END
) STORED;

ALTER TABLE "RagEmbedding" ADD COLUMN "organizationId" TEXT,
ADD COLUMN "accessClass" "KnowledgeAccessClass";

CREATE INDEX "RagChunk_tsvEnglish_idx" ON "RagChunk" USING GIN ("tsvEnglish");
CREATE INDEX "RagChunk_text_trgm_idx" ON "RagChunk" USING GIN ("text" gin_trgm_ops);
CREATE INDEX "RagChunk_organizationId_status_accessClass_idx" ON "RagChunk"("organizationId", "status", "accessClass");
CREATE INDEX "RagDocument_knowledgeVersionId_idx" ON "RagDocument"("knowledgeVersionId");
CREATE INDEX "RagEmbedding_organizationId_embeddingModel_embeddingVersion_idx" ON "RagEmbedding"("organizationId", "embeddingModel", "embeddingVersion");

-- Owner: a facility record, a Person, or (new) a knowledge document. Never two kinds;
-- an access class only on KNOWLEDGE rows; a KNOWLEDGE row has no patient and no person.
ALTER TABLE "RagDocument" DROP CONSTRAINT "RagDocument_owner_check";
ALTER TABLE "RagDocument" ADD CONSTRAINT "RagDocument_owner_check" CHECK (
  ("ownerType" = 'FACILITY_PATIENT' AND "facilityId" IS NOT NULL AND "patientId" IS NOT NULL AND "accessClass" IS NULL AND "knowledgeVersionId" IS NULL)
  OR ("ownerType" = 'PERSON' AND "personId" IS NOT NULL AND "facilityId" IS NULL AND "patientId" IS NULL AND "organizationId" IS NULL AND "accessClass" IS NULL AND "knowledgeVersionId" IS NULL)
  OR ("ownerType" = 'KNOWLEDGE' AND "organizationId" IS NOT NULL AND "patientId" IS NULL AND "personId" IS NULL AND "encounterId" IS NULL AND "accessClass" IS NOT NULL AND "knowledgeVersionId" IS NOT NULL)
) NOT VALID;
ALTER TABLE "RagChunk" DROP CONSTRAINT "RagChunk_owner_check";
ALTER TABLE "RagChunk" ADD CONSTRAINT "RagChunk_owner_check" CHECK (
  ("ownerType" = 'FACILITY_PATIENT' AND "facilityId" IS NOT NULL AND "patientId" IS NOT NULL AND "accessClass" IS NULL AND "organizationId" IS NULL)
  OR ("ownerType" = 'PERSON' AND "personId" IS NOT NULL AND "facilityId" IS NULL AND "patientId" IS NULL AND "accessClass" IS NULL AND "organizationId" IS NULL)
  OR ("ownerType" = 'KNOWLEDGE' AND "organizationId" IS NOT NULL AND "patientId" IS NULL AND "personId" IS NULL AND "accessClass" IS NOT NULL)
) NOT VALID;
ALTER TABLE "RagEmbedding" DROP CONSTRAINT "RagEmbedding_owner_check";
ALTER TABLE "RagEmbedding" ADD CONSTRAINT "RagEmbedding_owner_check" CHECK (
  ("ownerType" = 'FACILITY_PATIENT' AND "facilityId" IS NOT NULL AND "patientId" IS NOT NULL AND "accessClass" IS NULL AND "organizationId" IS NULL)
  OR ("ownerType" = 'PERSON' AND "personId" IS NOT NULL AND "facilityId" IS NULL AND "patientId" IS NULL AND "accessClass" IS NULL AND "organizationId" IS NULL)
  OR ("ownerType" = 'KNOWLEDGE' AND "organizationId" IS NOT NULL AND "patientId" IS NULL AND "personId" IS NULL AND "accessClass" IS NOT NULL)
) NOT VALID;

-- Origin: patient-provided rows are the Person's; imported rows are a facility
-- record's and staff-only (decided 2026-11-17); knowledge rows are approved
-- documents (labelled "reference" by owner type), staff-only.
ALTER TABLE "RagDocument" DROP CONSTRAINT "RagDocument_origin_check";
ALTER TABLE "RagDocument" ADD CONSTRAINT "RagDocument_origin_check" CHECK (
  ("origin" <> 'PATIENT_PROVIDED' OR "ownerType" = 'PERSON')
  AND ("origin" <> 'IMPORTED' OR ("ownerType" = 'FACILITY_PATIENT' AND "audience" = 'STAFF_ONLY'))
  AND ("ownerType" <> 'KNOWLEDGE' OR ("origin" = 'VERIFIED' AND "audience" = 'STAFF_ONLY'))
) NOT VALID;
ALTER TABLE "RagChunk" DROP CONSTRAINT "RagChunk_origin_check";
ALTER TABLE "RagChunk" ADD CONSTRAINT "RagChunk_origin_check" CHECK (
  ("origin" <> 'PATIENT_PROVIDED' OR "ownerType" = 'PERSON')
  AND ("origin" <> 'IMPORTED' OR ("ownerType" = 'FACILITY_PATIENT' AND "audience" = 'STAFF_ONLY'))
  AND ("ownerType" <> 'KNOWLEDGE' OR ("origin" = 'VERIFIED' AND "audience" = 'STAFF_ONLY'))
) NOT VALID;

-- Sharing categories are a patient record's; a knowledge row has none, every other row at least one.
ALTER TABLE "RagDocument" DROP CONSTRAINT "RagDocument_categories_check";
ALTER TABLE "RagDocument" ADD CONSTRAINT "RagDocument_categories_check" CHECK ((cardinality("categories") = 0) = ("ownerType" = 'KNOWLEDGE')) NOT VALID;
ALTER TABLE "RagChunk" DROP CONSTRAINT "RagChunk_categories_check";
ALTER TABLE "RagChunk" ADD CONSTRAINT "RagChunk_categories_check" CHECK ((cardinality("categories") = 0) = ("ownerType" = 'KNOWLEDGE')) NOT VALID;
ALTER TABLE "RagEmbedding" DROP CONSTRAINT "RagEmbedding_categories_check";
ALTER TABLE "RagEmbedding" ADD CONSTRAINT "RagEmbedding_categories_check" CHECK ((cardinality("categories") = 0) = ("ownerType" = 'KNOWLEDGE')) NOT VALID;
ALTER TABLE "RagChunk" ADD CONSTRAINT "RagChunk_language_check" CHECK ("language" ~ '^[a-z]{2}$') NOT VALID;
ALTER TABLE "RagChunk" ADD CONSTRAINT "RagChunk_page_check" CHECK ("pageNumber" IS NULL OR "pageNumber" >= 1) NOT VALID;

ALTER TABLE "RagDocument" VALIDATE CONSTRAINT "RagDocument_owner_check";
ALTER TABLE "RagChunk" VALIDATE CONSTRAINT "RagChunk_owner_check";
ALTER TABLE "RagEmbedding" VALIDATE CONSTRAINT "RagEmbedding_owner_check";
ALTER TABLE "RagDocument" VALIDATE CONSTRAINT "RagDocument_origin_check";
ALTER TABLE "RagChunk" VALIDATE CONSTRAINT "RagChunk_origin_check";
ALTER TABLE "RagDocument" VALIDATE CONSTRAINT "RagDocument_categories_check";
ALTER TABLE "RagChunk" VALIDATE CONSTRAINT "RagChunk_categories_check";
ALTER TABLE "RagEmbedding" VALIDATE CONSTRAINT "RagEmbedding_categories_check";
ALTER TABLE "RagChunk" VALIDATE CONSTRAINT "RagChunk_language_check";
ALTER TABLE "RagChunk" VALIDATE CONSTRAINT "RagChunk_page_check";

-- The copies on the embedding still come from the chunk, now with the organisation and access class.
CREATE OR REPLACE FUNCTION "RagEmbedding_copy_chunk_filters"() RETURNS trigger AS $$
DECLARE c RECORD;
BEGIN
  SELECT "ownerType", "facilityId", "patientId", "personId", "status", "categories", "sensitiveCategory", "audience", "origin", "recordedAt", "sourceId", "organizationId", "accessClass"
    INTO c FROM "RagChunk" WHERE "id" = NEW."chunkId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RagEmbedding.chunkId names no chunk' USING ERRCODE = 'foreign_key_violation';
  END IF;
  NEW."ownerType" := c."ownerType"; NEW."facilityId" := c."facilityId"; NEW."patientId" := c."patientId"; NEW."personId" := c."personId";
  NEW."status" := c."status"; NEW."categories" := c."categories"; NEW."sensitiveCategory" := c."sensitiveCategory";
  NEW."audience" := c."audience"; NEW."origin" := c."origin"; NEW."recordedAt" := c."recordedAt"; NEW."sourceId" := c."sourceId";
  NEW."organizationId" := c."organizationId"; NEW."accessClass" := c."accessClass";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
