-- Week 4b, RAG step 3: the AI index (RagDocument, RagChunk, RagEmbedding,
-- RagEmbeddingSpace), AI interactions (AiInteraction, AiTextReadLog) and the
-- two platform reviewer roles (docs/RAG_DESIGN.md §3, §4.3). Additive: no
-- existing row changes. The index starts empty; the rag-indexer and the
-- backfill fill it.

-- CreateEnum
CREATE TYPE "RagOwnerType" AS ENUM ('FACILITY_PATIENT', 'PERSON');

-- CreateEnum
CREATE TYPE "RagSourceType" AS ENUM ('CLINICAL_NOTE', 'LAB_RESULT', 'IMAGING_REPORT', 'PATIENT_DOCUMENT', 'GENERATED_DOCUMENT', 'CLINICAL_DOCUMENT', 'OBSERVATION', 'DIAGNOSIS', 'ALLERGY', 'ALLERGY_STATUS', 'REFERRAL', 'PROBLEM', 'DISCHARGE_SUMMARY', 'PATIENT_PROVIDED_RECORD');

-- CreateEnum
CREATE TYPE "RagOrigin" AS ENUM ('VERIFIED', 'PATIENT_PROVIDED');

-- CreateEnum
CREATE TYPE "RagCategory" AS ENUM ('PRESCRIPTIONS', 'LABS', 'IMAGING', 'DISCHARGE_SUMMARIES', 'UPLOADS', 'CLINICAL_NOTES', 'DIAGNOSES', 'ALLERGIES', 'VITALS', 'REFERRALS');

-- CreateEnum
CREATE TYPE "RagSensitiveCategory" AS ENUM ('MENTAL_HEALTH', 'SEXUAL_HEALTH', 'HIV', 'SUBSTANCE_USE', 'REPRODUCTIVE_HEALTH');

-- CreateEnum
CREATE TYPE "RagAudience" AS ENUM ('STAFF_ONLY', 'PATIENT_VISIBLE');

-- CreateEnum
CREATE TYPE "RagDocumentStatus" AS ENUM ('ACTIVE', 'SUPERSEDED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "RagWithdrawReason" AS ENUM ('AMENDED', 'SOURCE_DELETED', 'REJECTED_BY_PATIENT', 'CONSENT_WITHDRAWN', 'ERASURE', 'REINDEX');

-- CreateEnum
CREATE TYPE "RagEmbeddingSpaceStatus" AS ENUM ('BUILDING', 'ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "AiInteractionOutcome" AS ENUM ('ANSWERED', 'NO_RECORD', 'REFUSED_SAFETY', 'CITATION_INVALID', 'RATE_LIMITED', 'ERROR');

-- CreateEnum
CREATE TYPE "AiTextScope" AS ENUM ('STAFF_SAFETY', 'PATIENT_OPT_IN', 'PATIENT_OPT_IN_SAFETY_REVIEW');

-- CreateEnum
CREATE TYPE "AiTextReadReason" AS ENUM ('SAFETY_INCIDENT', 'QUALITY_REVIEW', 'PATIENT_COMPLAINT', 'EVALUATION_SAMPLE', 'LEGAL_REQUEST');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "Role" ADD VALUE 'CLINICAL_ADVISOR';
ALTER TYPE "Role" ADD VALUE 'SAFETY_OFFICER';

-- CreateTable
CREATE TABLE "RagDocument" (
    "id" TEXT NOT NULL,
    "ownerType" "RagOwnerType" NOT NULL,
    "organizationId" TEXT,
    "facilityId" TEXT,
    "patientId" TEXT,
    "personId" TEXT,
    "encounterId" TEXT,
    "sourceType" "RagSourceType" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceVersion" INTEGER NOT NULL,
    "origin" "RagOrigin" NOT NULL,
    "originalLanguage" TEXT NOT NULL DEFAULT 'en',
    "contentHash" TEXT NOT NULL,
    "categories" "RagCategory"[],
    "sensitiveCategory" "RagSensitiveCategory",
    "audience" "RagAudience" NOT NULL,
    "title" TEXT NOT NULL,
    "handwritten" BOOLEAN NOT NULL DEFAULT false,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "status" "RagDocumentStatus" NOT NULL DEFAULT 'ACTIVE',
    "indexedFromEventId" TEXT,
    "embeddingModel" TEXT NOT NULL,
    "embeddingDim" INTEGER NOT NULL,
    "withdrawnAt" TIMESTAMP(3),
    "withdrawnReason" "RagWithdrawReason",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RagDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RagChunk" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "chunkNo" INTEGER NOT NULL,
    "ownerType" "RagOwnerType" NOT NULL,
    "facilityId" TEXT,
    "patientId" TEXT,
    "personId" TEXT,
    "categories" "RagCategory"[],
    "sensitiveCategory" "RagSensitiveCategory",
    "origin" "RagOrigin" NOT NULL,
    "audience" "RagAudience" NOT NULL,
    "status" "RagDocumentStatus" NOT NULL DEFAULT 'ACTIVE',
    "sourceType" "RagSourceType" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "handwritten" BOOLEAN NOT NULL DEFAULT false,
    "context" TEXT NOT NULL,
    "heading" TEXT,
    "text" TEXT NOT NULL,
    "translatedText" TEXT,
    "translationLanguage" TEXT,
    "tokenCount" INTEGER NOT NULL,
    "tsv" tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce("context", '') || ' ' || coalesce("heading", '') || ' ' || "text" || ' ' || coalesce("translatedText", ''))) STORED,

    CONSTRAINT "RagChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RagEmbedding" (
    "id" TEXT NOT NULL,
    "chunkId" TEXT NOT NULL,
    "embeddingModel" TEXT NOT NULL,
    "embeddingVersion" INTEGER NOT NULL,
    "dims" INTEGER NOT NULL,
    "embedding" halfvec NOT NULL,
    "ownerType" "RagOwnerType" NOT NULL,
    "facilityId" TEXT,
    "patientId" TEXT,
    "personId" TEXT,
    "status" "RagDocumentStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RagEmbedding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RagEmbeddingSpace" (
    "id" TEXT NOT NULL,
    "embeddingModel" TEXT NOT NULL,
    "embeddingVersion" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "dims" INTEGER NOT NULL,
    "status" "RagEmbeddingSpaceStatus" NOT NULL DEFAULT 'BUILDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),
    "activatedByUserId" TEXT,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "RagEmbeddingSpace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiInteraction" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "facilityId" TEXT,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "patientId" TEXT,
    "personId" TEXT,
    "proxyGrantId" TEXT,
    "shareId" TEXT,
    "consentId" TEXT,
    "mode" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "embeddingModel" TEXT NOT NULL,
    "embeddingVersion" INTEGER NOT NULL,
    "outcome" "AiInteractionOutcome" NOT NULL,
    "retrievedChunkIds" TEXT[],
    "citedChunkIds" TEXT[],
    "topScore" DOUBLE PRECISION,
    "threshold" DOUBLE PRECISION,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL,
    "questionCiphertext" TEXT,
    "answerCiphertext" TEXT,
    "keyVersion" INTEGER,
    "textScope" "AiTextScope",
    "textExpiresAt" TIMESTAMP(3),
    "metadataExpiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiInteraction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiTextReadLog" (
    "id" TEXT NOT NULL,
    "interactionId" TEXT NOT NULL,
    "readerUserId" TEXT NOT NULL,
    "readerRole" TEXT NOT NULL,
    "reasonCode" "AiTextReadReason" NOT NULL,
    "ticketRef" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiTextReadLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RagDocument_facilityId_patientId_status_idx" ON "RagDocument"("facilityId", "patientId", "status");

-- CreateIndex
CREATE INDEX "RagDocument_personId_status_idx" ON "RagDocument"("personId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RagDocument_sourceType_sourceId_sourceVersion_key" ON "RagDocument"("sourceType", "sourceId", "sourceVersion");

-- CreateIndex
CREATE INDEX "RagChunk_facilityId_patientId_status_audience_idx" ON "RagChunk"("facilityId", "patientId", "status", "audience");

-- CreateIndex
CREATE INDEX "RagChunk_personId_status_audience_idx" ON "RagChunk"("personId", "status", "audience");

-- CreateIndex
CREATE UNIQUE INDEX "RagChunk_documentId_chunkNo_key" ON "RagChunk"("documentId", "chunkNo");

-- CreateIndex
CREATE INDEX "RagEmbedding_patientId_embeddingModel_embeddingVersion_idx" ON "RagEmbedding"("patientId", "embeddingModel", "embeddingVersion");

-- CreateIndex
CREATE INDEX "RagEmbedding_personId_embeddingModel_embeddingVersion_idx" ON "RagEmbedding"("personId", "embeddingModel", "embeddingVersion");

-- CreateIndex
CREATE UNIQUE INDEX "RagEmbedding_chunkId_embeddingModel_embeddingVersion_key" ON "RagEmbedding"("chunkId", "embeddingModel", "embeddingVersion");

-- CreateIndex
CREATE UNIQUE INDEX "RagEmbeddingSpace_embeddingModel_embeddingVersion_key" ON "RagEmbeddingSpace"("embeddingModel", "embeddingVersion");

-- CreateIndex
CREATE INDEX "AiInteraction_facilityId_createdAt_idx" ON "AiInteraction"("facilityId", "createdAt");

-- CreateIndex
CREATE INDEX "AiInteraction_userId_createdAt_idx" ON "AiInteraction"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AiInteraction_personId_idx" ON "AiInteraction"("personId");

-- CreateIndex
CREATE INDEX "AiInteraction_patientId_idx" ON "AiInteraction"("patientId");

-- CreateIndex
CREATE INDEX "AiInteraction_textExpiresAt_idx" ON "AiInteraction"("textExpiresAt");

-- CreateIndex
CREATE INDEX "AiTextReadLog_readAt_idx" ON "AiTextReadLog"("readAt");

-- CreateIndex
CREATE INDEX "AiTextReadLog_interactionId_idx" ON "AiTextReadLog"("interactionId");

-- AddForeignKey
ALTER TABLE "RagDocument" ADD CONSTRAINT "RagDocument_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RagDocument" ADD CONSTRAINT "RagDocument_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RagDocument" ADD CONSTRAINT "RagDocument_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RagChunk" ADD CONSTRAINT "RagChunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "RagDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RagEmbedding" ADD CONSTRAINT "RagEmbedding_chunkId_fkey" FOREIGN KEY ("chunkId") REFERENCES "RagChunk"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- ── What Prisma can't express ────────────────────────────────────────────

-- Full-text search over each chunk (the generated "tsv" column above).
CREATE INDEX "RagChunk_tsv_idx" ON "RagChunk" USING GIN ("tsv");

-- Owner: a facility record, or a Person (never both kinds of owner).
ALTER TABLE "RagDocument" ADD CONSTRAINT "RagDocument_owner_check" CHECK (
  ("ownerType" = 'FACILITY_PATIENT' AND "facilityId" IS NOT NULL AND "patientId" IS NOT NULL)
  OR ("ownerType" = 'PERSON' AND "personId" IS NOT NULL AND "facilityId" IS NULL AND "patientId" IS NULL AND "organizationId" IS NULL)
);
ALTER TABLE "RagChunk" ADD CONSTRAINT "RagChunk_owner_check" CHECK (
  ("ownerType" = 'FACILITY_PATIENT' AND "facilityId" IS NOT NULL AND "patientId" IS NOT NULL)
  OR ("ownerType" = 'PERSON' AND "personId" IS NOT NULL AND "facilityId" IS NULL AND "patientId" IS NULL)
);
ALTER TABLE "RagEmbedding" ADD CONSTRAINT "RagEmbedding_owner_check" CHECK (
  ("ownerType" = 'FACILITY_PATIENT' AND "facilityId" IS NOT NULL AND "patientId" IS NOT NULL)
  OR ("ownerType" = 'PERSON' AND "personId" IS NOT NULL AND "facilityId" IS NULL AND "patientId" IS NULL)
);
-- Patient-provided sources belong to the Person.
ALTER TABLE "RagDocument" ADD CONSTRAINT "RagDocument_origin_check" CHECK ("origin" <> 'PATIENT_PROVIDED' OR "ownerType" = 'PERSON');
ALTER TABLE "RagChunk" ADD CONSTRAINT "RagChunk_origin_check" CHECK ("origin" <> 'PATIENT_PROVIDED' OR "ownerType" = 'PERSON');
-- Every document has at least one category; a withdrawn one says why.
ALTER TABLE "RagDocument" ADD CONSTRAINT "RagDocument_categories_check" CHECK (cardinality("categories") >= 1);
ALTER TABLE "RagChunk" ADD CONSTRAINT "RagChunk_categories_check" CHECK (cardinality("categories") >= 1);
ALTER TABLE "RagDocument" ADD CONSTRAINT "RagDocument_withdrawn_check" CHECK ("status" <> 'WITHDRAWN' OR ("withdrawnAt" IS NOT NULL AND "withdrawnReason" IS NOT NULL));

-- The vector has the dimension it says (no fixed-dimension column: decision 8).
ALTER TABLE "RagEmbedding" ADD CONSTRAINT "RagEmbedding_dims_check" CHECK ("dims" > 0 AND vector_dims("embedding") = "dims");
-- Keep each vector on its heap row (half precision: 2 KB at 1024 dimensions)
-- rather than in TOAST, so the exact cosine scan over one patient's rows reads
-- them directly: the latency budget (p95 < 150 ms at 20,000 chunks) depends on it.
ALTER TABLE "RagEmbedding" ALTER COLUMN "embedding" SET STORAGE MAIN;
ALTER TABLE "RagEmbedding" SET (toast_tuple_target = 8160);

-- Exactly one active embedding space.
CREATE UNIQUE INDEX "RagEmbeddingSpace_one_active" ON "RagEmbeddingSpace" ((true)) WHERE "status" = 'ACTIVE';
-- The index starts in the deterministic offline space (docs/RAG_DESIGN.md §6.2);
-- moving to another provider is a re-embed job and an audited switch.
INSERT INTO "RagEmbeddingSpace" ("id", "embeddingModel", "embeddingVersion", "provider", "dims", "status", "activatedAt")
VALUES ('rag-space-mock-1', 'mock-hash-1024', 1, 'mock', 1024, 'ACTIVE', CURRENT_TIMESTAMP);

-- Retained text is complete or absent: ciphertext, key version, scope and expiry together.
ALTER TABLE "AiInteraction" ADD CONSTRAINT "AiInteraction_text_check" CHECK (
  ("questionCiphertext" IS NULL AND "answerCiphertext" IS NULL AND "keyVersion" IS NULL AND "textScope" IS NULL AND "textExpiresAt" IS NULL)
  OR ("questionCiphertext" IS NOT NULL AND "keyVersion" IS NOT NULL AND "textScope" IS NOT NULL AND "textExpiresAt" IS NOT NULL)
);
-- Staff text is kept at most 90 days.
ALTER TABLE "AiInteraction" ADD CONSTRAINT "AiInteraction_text_retention_check" CHECK ("textExpiresAt" IS NULL OR "textExpiresAt" <= "createdAt" + interval '90 days');
-- A read of retained text names a ticket.
ALTER TABLE "AiTextReadLog" ADD CONSTRAINT "AiTextReadLog_ticket_check" CHECK (length(btrim("ticketRef")) >= 3);
