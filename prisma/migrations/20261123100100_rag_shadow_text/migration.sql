-- RAG Phase 3, steps 3.5 and 3.9 (docs/RAG_IMPLEMENTATION_PLAN.md §5.1): a
-- chunk's index-only terms — its Indic words romanised (deterministic, no
-- model) and the canonical names of the medicines it names. Never shown,
-- never a source, never sent to a model: it only lets a Latin-script query
-- ("madhumeh") and a medicine's other name ("albuterol") find the chunk.
--
-- Additive: one nullable column, filled by the indexer for new chunks and by
-- the runner's bounded backfill for existing ones; a generated tsvector over
-- it; two GIN indexes. No existing value is changed. (Adding the generated
-- column computes it for every row: on an empty column, an empty vector.)
--
-- Plan §5.2's `legacy_result_index_support` was not needed: imported results
-- are indexed through the existing tables and indexes (step 3.6).

ALTER TABLE "RagChunk" ADD COLUMN "shadowText" TEXT,
ADD COLUMN "tsvShadow" tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce("shadowText", ''))) STORED;

CREATE INDEX "RagChunk_tsvShadow_idx" ON "RagChunk" USING GIN ("tsvShadow");
CREATE INDEX "RagChunk_shadowText_trgm_idx" ON "RagChunk" USING GIN ("shadowText" gin_trgm_ops);
