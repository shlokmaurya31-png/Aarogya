import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { KnowledgeScope } from "./knowledgeSearch";

/**
 * RAG Phase 4, step 4.4 — the knowledge retrieval cache (docs/RAG_ARCHITECTURE.md
 * §14). KNOWLEDGE_QA only; there is no retrieval cache for patient or person
 * data, by design (access there changes on consent, share, proxy, link,
 * assignment and care window, and retrieval takes ~60 ms).
 *
 * The key holds everything access depends on, so a hit can never cross a
 * boundary: the organisation, the facility, the user, the role, the access
 * classes (a role or class change is a different key), the set of versions in
 * force now (any publish, withdrawal, supersession or expiry is a different
 * key), the embedding space and the candidate counts, and the normalised
 * question. Invalidation is by key, not by event. A row holds chunk ids and
 * scores, never text or the question; it lives ten minutes. A hit is re-read
 * through the same scope and in-force SQL by the caller.
 */
export const RETRIEVAL_CACHE_TTL_MS = 10 * 60_000;

export interface RetrievalKeyInput {
  scope: KnowledgeScope; userId: string; role: string; space: { model: string; version: number };
  counts: { vector: number; keyword: number; rerank: number }; question: string; now?: Date;
}

export const normaliseQuestion = (q: string) => q.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/** The versions in force for this scope now, as one sorted list (part of the key). */
export async function inForceVersionSet(scope: KnowledgeScope, now = new Date()): Promise<string[]> {
  if (!scope.accessClasses.length) return [];
  const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT v."id" FROM "KnowledgeDocumentVersion" v JOIN "KnowledgeDocument" d ON d."id" = v."documentId"
    WHERE d."organizationId" = ${scope.organizationId} AND (d."facilityId" IS NULL OR d."facilityId" = ${scope.facilityId})
      AND d."accessClass" = ANY(${[...scope.accessClasses]}::"KnowledgeAccessClass"[])
      AND v."publishedAt" <= ${now} AND v."withdrawnAt" IS NULL AND v."supersededByVersionId" IS NULL AND (v."expiresAt" IS NULL OR v."expiresAt" > ${now})
    ORDER BY v."id"`);
  return rows.map((r) => r.id);
}

export async function retrievalKey(k: RetrievalKeyInput): Promise<string> {
  const versions = await inForceVersionSet(k.scope, k.now);
  const parts = {
    org: k.scope.organizationId, facility: k.scope.facilityId, user: k.userId, role: k.role, classes: [...k.scope.accessClasses].sort(),
    versions, space: k.space, counts: k.counts, question: createHash("sha256").update(normaliseQuestion(k.question), "utf8").digest("hex"),
  };
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
}

export interface CachedRetrieval { chunkIds: string[]; scores: number[]; topScore: number }

/** A live row for this key (counted as a hit), or null. */
export async function readRetrievalCache(keyHash: string, now = new Date()): Promise<CachedRetrieval | null> {
  const rows = await prisma.$queryRaw<CachedRetrieval[]>(Prisma.sql`
    UPDATE "AiRetrievalCache" SET "hits" = "hits" + 1 WHERE "keyHash" = ${keyHash} AND "expiresAt" > ${now}
    RETURNING "chunkIds", "scores", "topScore"`);
  return rows[0] ?? null;
}

/** Stores a retrieval under its key (ids and scores only), replacing an expired row. */
export async function writeRetrievalCache(keyHash: string, who: { organizationId: string; facilityId: string; userId: string }, r: CachedRetrieval, now = new Date()): Promise<void> {
  const expiresAt = new Date(now.getTime() + RETRIEVAL_CACHE_TTL_MS);
  await prisma.$executeRaw`
    INSERT INTO "AiRetrievalCache" ("id", "keyHash", "organizationId", "facilityId", "userId", "chunkIds", "scores", "topScore", "createdAt", "expiresAt")
    VALUES (${`arc_${keyHash.slice(0, 24)}`}, ${keyHash}, ${who.organizationId}, ${who.facilityId}, ${who.userId}, ${r.chunkIds}::text[], ${r.scores}::double precision[], ${r.topScore}, ${now}, ${expiresAt})
    ON CONFLICT ("keyHash") DO UPDATE SET "chunkIds" = EXCLUDED."chunkIds", "scores" = EXCLUDED."scores", "topScore" = EXCLUDED."topScore", "createdAt" = EXCLUDED."createdAt", "expiresAt" = EXCLUDED."expiresAt", "hits" = 0
    WHERE "AiRetrievalCache"."expiresAt" <= ${now}`;
}

/** A row whose passages no longer all pass the scope (it can only happen through a race); the caller retrieves afresh. */
export async function dropRetrievalCache(keyHash: string): Promise<void> {
  await prisma.aiRetrievalCache.deleteMany({ where: { keyHash } });
}

/** The runner's sweep: expired rows. */
export async function sweepRetrievalCache(now = new Date()): Promise<number> {
  return (await prisma.aiRetrievalCache.deleteMany({ where: { expiresAt: { lte: now } } })).count;
}
