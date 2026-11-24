-- RAG Phase 4, step 4.4: cached knowledge retrieval, keyed by access scope (docs/RAG_ARCHITECTURE.md §14).
-- Additive: a new table; no existing row is touched. Holds ids and scores, never text.
CREATE TABLE "AiRetrievalCache" (
    "id" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chunkIds" TEXT[],
    "scores" DOUBLE PRECISION[],
    "topScore" DOUBLE PRECISION NOT NULL,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiRetrievalCache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiRetrievalCache_keyHash_key" ON "AiRetrievalCache"("keyHash");
CREATE INDEX "AiRetrievalCache_expiresAt_idx" ON "AiRetrievalCache"("expiresAt");
CREATE INDEX "AiRetrievalCache_organizationId_facilityId_userId_idx" ON "AiRetrievalCache"("organizationId", "facilityId", "userId");
ALTER TABLE "AiRetrievalCache" ADD CONSTRAINT "AiRetrievalCache_key_check" CHECK ("keyHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "AiRetrievalCache" ADD CONSTRAINT "AiRetrievalCache_shape_check" CHECK (cardinality("chunkIds") = cardinality("scores") AND "expiresAt" > "createdAt");
