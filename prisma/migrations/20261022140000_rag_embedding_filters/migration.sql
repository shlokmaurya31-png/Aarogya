-- Week 4b: the vector search filters on the embedding row alone (found by the
-- latency gate on CI: joining every candidate chunk cost ~20,000 index
-- lookups per query). The chunk's remaining filter columns are copied onto
-- RagEmbedding — by a trigger, from the chunk itself, so they can never
-- disagree. Existing rows are filled from their chunks (an exact copy).

-- AlterTable
ALTER TABLE "RagEmbedding" ADD COLUMN "audience" "RagAudience",
ADD COLUMN "categories" "RagCategory"[],
ADD COLUMN "origin" "RagOrigin",
ADD COLUMN "recordedAt" TIMESTAMP(3),
ADD COLUMN "sensitiveCategory" "RagSensitiveCategory",
ADD COLUMN "sourceId" TEXT;

UPDATE "RagEmbedding" e SET "categories" = c."categories", "sensitiveCategory" = c."sensitiveCategory", "audience" = c."audience", "origin" = c."origin", "recordedAt" = c."recordedAt", "sourceId" = c."sourceId"
FROM "RagChunk" c WHERE c."id" = e."chunkId";

ALTER TABLE "RagEmbedding" ALTER COLUMN "audience" SET NOT NULL,
ALTER COLUMN "categories" SET NOT NULL,
ALTER COLUMN "origin" SET NOT NULL,
ALTER COLUMN "recordedAt" SET NOT NULL,
ALTER COLUMN "sourceId" SET NOT NULL;
ALTER TABLE "RagEmbedding" ADD CONSTRAINT "RagEmbedding_categories_check" CHECK (cardinality("categories") >= 1);

-- The copies always come from the chunk (whatever the writer sent).
CREATE FUNCTION "RagEmbedding_copy_chunk_filters"() RETURNS trigger AS $$
DECLARE c RECORD;
BEGIN
  SELECT "ownerType", "facilityId", "patientId", "personId", "status", "categories", "sensitiveCategory", "audience", "origin", "recordedAt", "sourceId"
    INTO c FROM "RagChunk" WHERE "id" = NEW."chunkId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RagEmbedding.chunkId names no chunk' USING ERRCODE = 'foreign_key_violation';
  END IF;
  NEW."ownerType" := c."ownerType"; NEW."facilityId" := c."facilityId"; NEW."patientId" := c."patientId"; NEW."personId" := c."personId";
  NEW."status" := c."status"; NEW."categories" := c."categories"; NEW."sensitiveCategory" := c."sensitiveCategory";
  NEW."audience" := c."audience"; NEW."origin" := c."origin"; NEW."recordedAt" := c."recordedAt"; NEW."sourceId" := c."sourceId";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "RagEmbedding_copy_chunk_filters_trg" BEFORE INSERT ON "RagEmbedding"
  FOR EACH ROW EXECUTE FUNCTION "RagEmbedding_copy_chunk_filters"();

-- A chunk's filter columns change only by its Person being set or cleared (a link change); keep the copies in step.
CREATE FUNCTION "RagChunk_sync_embedding_filters"() RETURNS trigger AS $$
BEGIN
  UPDATE "RagEmbedding" SET "personId" = NEW."personId", "status" = NEW."status" WHERE "chunkId" = NEW."id";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "RagChunk_sync_embedding_filters_trg" AFTER UPDATE OF "personId", "status" ON "RagChunk"
  FOR EACH ROW EXECUTE FUNCTION "RagChunk_sync_embedding_filters"();
