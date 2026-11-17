import { createHash } from "node:crypto";
import { Prisma, type RagEmbeddingSpace } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resolveEffectiveInternal } from "@/lib/config/resolver";
import { EmbeddingUnavailableError } from "@/lib/ai/embeddings/types";
import type { AiPermit } from "@/lib/ai/record/types";
import { computeEmbeddings } from "./embed";
import { vectorLiteral } from "./search";

/**
 * RAG Phase 1 — the embedding cache (docs/RAG_ARCHITECTURE.md §9, §14; ADR
 * 0005 part B): a vector by the sha-256 of the exact text, within one
 * embedding space, so identical text is embedded once.
 *
 * For KNOWLEDGE text only (a document's chunks, and knowledge-mode questions):
 * text that names no patient. Patient and person text is never looked up or
 * stored here: its vectors live only beside its chunk, under its access rules,
 * and a question about a patient is embedded per request and kept nowhere.
 * Holds a hash and a vector, never text.
 */
export const contentHash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

type CacheRow = { contentHash: string; embedding: string };

export async function cachedKnowledgeEmbeddings(space: RagEmbeddingSpace, texts: string[], permit: AiPermit): Promise<{ vectors: number[][]; hits: number; embedded: number }> {
  if (!texts.length) return { vectors: [], hits: 0, embedded: 0 };
  // Knowledge text has no person: a permit issued for a person's or a patient's data is the wrong call here.
  if (permit.real || !permit.subject.startsWith("knowledge:")) throw new Error("The embedding cache is for knowledge text only.");
  // Decided 2026-11-17: an organisation's knowledge goes to an external provider only if it turned that on (default off).
  if (space.provider !== "mock") {
    const organizationId = permit.subject.slice("knowledge:".length);
    const eff = await resolveEffectiveInternal({ key: "ai.knowledge.external_providers", organizationId, fallbackRaw: "false" });
    if (eff.value !== true) throw new EmbeddingUnavailableError("REAL_DATA_REFUSED");
  }
  const hashes = texts.map(contentHash);
  const unique = [...new Set(hashes)];
  const found = await prisma.$queryRaw<CacheRow[]>(Prisma.sql`
    UPDATE "AiEmbeddingCache" SET "lastUsedAt" = now()
    WHERE "embeddingModel" = ${space.embeddingModel} AND "embeddingVersion" = ${space.embeddingVersion} AND "contentHash" = ANY(${unique}::text[])
    RETURNING "contentHash", "embedding"::text AS "embedding"`);
  const byHash = new Map(found.map((r) => [r.contentHash, JSON.parse(r.embedding) as number[]]));
  const missing = unique.filter((h) => !byHash.has(h));
  if (missing.length) {
    const textOf = new Map(hashes.map((h, i) => [h, texts[i]]));
    const vectors = await computeEmbeddings(space, missing.map((h) => textOf.get(h)!), permit);
    const rows = missing.map((h, i) => Prisma.sql`(${`emc_${space.id}_${h}`}, ${space.embeddingModel}, ${space.embeddingVersion}, ${h}, ${space.dims}, ${vectorLiteral(vectors[i])}::halfvec)`);
    await prisma.$executeRaw`INSERT INTO "AiEmbeddingCache" ("id", "embeddingModel", "embeddingVersion", "contentHash", "dims", "embedding")
      VALUES ${Prisma.join(rows)} ON CONFLICT ("embeddingModel", "embeddingVersion", "contentHash") DO NOTHING`;
    missing.forEach((h, i) => byHash.set(h, vectors[i]));
  }
  return { vectors: hashes.map((h) => byHash.get(h)!), hits: unique.length - missing.length, embedded: missing.length };
}
