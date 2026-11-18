-- RAG Phase 1: accounting on the interaction log, attribution that outlives
-- the index, and the embedding cache (docs/RAG_ARCHITECTURE.md §11.5, §13.4;
-- ADR 0005 part B). Additive.

ALTER TABLE "AiInteraction" ADD COLUMN "module" TEXT,
ADD COLUMN "intent" TEXT,
ADD COLUMN "tier" INTEGER,
ADD COLUMN "provider" TEXT,
ADD COLUMN "embeddingTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "rerankUnits" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "estimatedCostMicroUsd" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "cacheHits" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "retrievalMs" INTEGER,
ADD COLUMN "generationMs" INTEGER;
ALTER TABLE "AiInteraction" ADD CONSTRAINT "AiInteraction_accounting_check" CHECK (
  "embeddingTokens" >= 0 AND "rerankUnits" >= 0 AND "estimatedCostMicroUsd" >= 0 AND "cacheHits" >= 0
  AND ("tier" IS NULL OR "tier" BETWEEN 0 AND 3) AND ("retrievalMs" IS NULL OR "retrievalMs" >= 0) AND ("generationMs" IS NULL OR "generationMs" >= 0)
);

-- What an answer rested on, one row per source: no text, ever.
CREATE TABLE "AiInteractionSource" (
    "id" TEXT NOT NULL,
    "interactionId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "cited" BOOLEAN NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "chunkId" TEXT,
    "ragDocumentId" TEXT,
    "sourceVersion" INTEGER,
    "knowledgeVersionId" TEXT,
    "pageNumber" INTEGER,
    "sectionPath" TEXT,
    "origin" "RagOrigin" NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiInteractionSource_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AiInteractionSource_sourceType_sourceId_idx" ON "AiInteractionSource"("sourceType", "sourceId");
CREATE UNIQUE INDEX "AiInteractionSource_interactionId_rank_key" ON "AiInteractionSource"("interactionId", "rank");
ALTER TABLE "AiInteractionSource" ADD CONSTRAINT "AiInteractionSource_interactionId_fkey" FOREIGN KEY ("interactionId") REFERENCES "AiInteraction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiInteractionSource" ADD CONSTRAINT "AiInteractionSource_kind_check" CHECK ("sourceKind" IN ('CHUNK', 'LIVE', 'UPLOAD') AND "rank" >= 1);

-- A vector by content hash within one embedding space (knowledge text only): a hash and a vector, never text.
CREATE TABLE "AiEmbeddingCache" (
    "id" TEXT NOT NULL,
    "embeddingModel" TEXT NOT NULL,
    "embeddingVersion" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "dims" INTEGER NOT NULL,
    "embedding" halfvec NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiEmbeddingCache_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AiEmbeddingCache_lastUsedAt_idx" ON "AiEmbeddingCache"("lastUsedAt");
CREATE UNIQUE INDEX "AiEmbeddingCache_embeddingModel_embeddingVersion_contentHas_key" ON "AiEmbeddingCache"("embeddingModel", "embeddingVersion", "contentHash");
ALTER TABLE "AiEmbeddingCache" ADD CONSTRAINT "AiEmbeddingCache_hash_check" CHECK ("contentHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "AiEmbeddingCache" ADD CONSTRAINT "AiEmbeddingCache_dims_check" CHECK ("dims" > 0 AND vector_dims("embedding") = "dims");
ALTER TABLE "AiEmbeddingCache" ALTER COLUMN "embedding" SET STORAGE MAIN;
