import { Prisma, type KnowledgeAccessClass, type KnowledgeDocumentType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { knowledgePermit } from "@/lib/ai/realData";
import { activeSpace } from "./embed";
import { cachedKnowledgeEmbeddings } from "./embedCache";
import { keywordSql, trigramThresholdSql, vectorLiteral, withoutExactLatin } from "./search";
import { queryTerms } from "./queryTerms";

/**
 * RAG Phase 2 — knowledge candidates, the retrieval that Phase 3's
 * KNOWLEDGE_QA mode will build on (docs/RAG_IMPLEMENTATION_PLAN.md §5.1 step
 * 3.4). Here it is what the ingestion gates search with: only the
 * organisation's documents, for the reader's facility or the whole
 * organisation, of the access classes given, and only a version in force —
 * published, not superseded, not withdrawn, not expired — all inside the SQL.
 * The in-force check is made against the version itself, so a version past
 * its expiry is out of the search before the runner's sweep reaches it.
 *
 * Keyword ("simple" tsvector) and vector candidates, fused by reciprocal rank
 * (k = 60). A knowledge scope admits no patient or person row by construction
 * (ownerType KNOWLEDGE), and no record scope admits a knowledge row.
 */
export interface KnowledgeScope { organizationId: string; facilityId: string; accessClasses: readonly KnowledgeAccessClass[] }
export interface KnowledgeHit {
  chunkId: string; ragDocumentId: string; chunkNo: number; knowledgeDocumentId: string; versionId: string; version: number; title: string; pageNumber: number | null; sectionPath: string | null; text: string; score: number;
  /** RAG Phase 3: for ranking (a facility's own document above an organisation-wide one; a document type's authority) and citations. */
  documentType: KnowledgeDocumentType; facilityWide: boolean; publishedAt: Date | null;
}

/** The scope's cheap filters on chunk `c` or embedding `e` (which carries the same columns): organisation, facility or organisation-wide, access class, ACTIVE. */
function baseSql(s: KnowledgeScope, alias: "c" | "e"): Prisma.Sql {
  const t = Prisma.raw(alias);
  return Prisma.sql`${t}."ownerType" = 'KNOWLEDGE' AND ${t}."status" = 'ACTIVE' AND ${t}."organizationId" = ${s.organizationId}
    AND (${t}."facilityId" IS NULL OR ${t}."facilityId" = ${s.facilityId})
    AND ${t}."accessClass" = ANY(${[...s.accessClasses]}::"KnowledgeAccessClass"[])`;
}

/** The chunk's version is in force now: published, not withdrawn, not superseded, not expired — checked against the version row itself. */
function inForceSql(chunkId: Prisma.Sql, now: Date): Prisma.Sql {
  return Prisma.sql`EXISTS (SELECT 1 FROM "RagChunk" kc JOIN "RagDocument" kd ON kd."id" = kc."documentId" JOIN "KnowledgeDocumentVersion" kv ON kv."id" = kd."knowledgeVersionId"
      WHERE kc."id" = ${chunkId} AND kd."status" = 'ACTIVE' AND kv."publishedAt" <= ${now}
        AND kv."withdrawnAt" IS NULL AND kv."supersededByVersionId" IS NULL AND (kv."expiresAt" IS NULL OR kv."expiresAt" > ${now}))`;
}

/** The whole scope on chunk `c`: the filters and the version in force (for the small queries: neighbours, the exact-word check). */
function scopeSql(s: KnowledgeScope, alias: "c", now: Date): Prisma.Sql {
  return Prisma.sql`${baseSql(s, alias)} AND ${inForceSql(Prisma.sql`c."id"`, now)}`;
}

/** Each search takes this many times its count under the cheap filters, then keeps only chunks of a version in force (RAG Phase 3: the per-row check over 20,000 chunks cost ~0.1 s). */
const OVERSAMPLE = 4;

export async function searchKnowledge(scope: KnowledgeScope, question: string, opts: { limit?: number; now?: Date; vectorLimit?: number; keywordLimit?: number } = {}): Promise<KnowledgeHit[]> {
  if (!scope.accessClasses.length) return [];
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 8;
  const vLimit = opts.vectorLimit ?? 40, kLimit = opts.keywordLimit ?? 40;
  // The vector and keyword searches are independent: each branch runs in parallel, fused here by reciprocal rank (k = 60).
  const vecBranch = async () => {
    const space = await activeSpace();
    const { vectors } = await cachedKnowledgeEmbeddings(space, [question], knowledgePermit(scope.organizationId));
    return prisma.$queryRaw<{ chunkId: string; rank: bigint }[]>`
      WITH vec0 AS (
        SELECT e."chunkId", e."embedding" <=> ${vectorLiteral(vectors[0])}::halfvec AS distance
        FROM "RagEmbedding" e
        WHERE e."embeddingModel" = ${space.embeddingModel} AND e."embeddingVersion" = ${space.embeddingVersion} AND ${baseSql(scope, "e")}
        ORDER BY distance, e."chunkId" LIMIT ${vLimit * OVERSAMPLE}
      )
      SELECT v."chunkId", row_number() OVER (ORDER BY v.distance, v."chunkId") AS rank FROM vec0 v
      WHERE ${inForceSql(Prisma.sql`v."chunkId"`, now)} ORDER BY v.distance, v."chunkId" LIMIT ${vLimit}`;
  };
  const kwBranch = async () => {
    // RAG Phase 3, step 3.5: the same keyword matchers as the record's (exact, English stems, shadow text, trigram).
    const k = await withoutExactLatin(prisma, baseSql(scope, "c"), queryTerms(question));
    const [, rows] = await prisma.$transaction([prisma.$queryRaw(trigramThresholdSql()), prisma.$queryRaw<{ chunkId: string; rank: bigint }[]>`
      WITH kw0 AS (${keywordSql(baseSql(scope, "c"), k, kLimit * OVERSAMPLE)})
      SELECT x."chunkId", row_number() OVER (ORDER BY x.rank) AS rank FROM kw0 x WHERE ${inForceSql(Prisma.sql`x."chunkId"`, now)} ORDER BY x.rank LIMIT ${kLimit}`]);
    return rows;
  };
  const [vecRows, kwRows] = await Promise.all([vecBranch(), kwBranch()]);
  const fusedScore = new Map<string, number>();
  for (const r of [...vecRows, ...kwRows]) fusedScore.set(r.chunkId, (fusedScore.get(r.chunkId) ?? 0) + 1 / (60 + Number(r.rank)));
  const rows = [...fusedScore].map(([chunkId, score]) => ({ chunkId, score })).sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId)).slice(0, limit);
  if (!rows.length) return [];
  const chunks = await prisma.ragChunk.findMany({
    where: { id: { in: rows.map((r) => r.chunkId) } },
    select: { id: true, documentId: true, chunkNo: true, sourceId: true, pageNumber: true, sectionPath: true, text: true, facilityId: true, document: { select: { knowledgeVersionId: true, sourceVersion: true, title: true } } },
  });
  const versions = new Map((await prisma.knowledgeDocumentVersion.findMany({ where: { id: { in: chunks.map((c) => c.document.knowledgeVersionId!).filter(Boolean) } }, select: { id: true, publishedAt: true, document: { select: { type: true } } } })).map((v) => [v.id, v]));
  const byId = new Map(chunks.map((x) => [x.id, x]));
  return rows.flatMap((r) => {
    const x = byId.get(r.chunkId);
    const v = x ? versions.get(x.document.knowledgeVersionId!) : undefined;
    return x && v ? [{
      chunkId: x.id, ragDocumentId: x.documentId, chunkNo: x.chunkNo, knowledgeDocumentId: x.sourceId, versionId: x.document.knowledgeVersionId!, version: x.document.sourceVersion, title: x.document.title,
      pageNumber: x.pageNumber, sectionPath: x.sectionPath, text: x.text, score: Number(r.score), documentType: v.document.type, facilityWide: x.facilityId === null, publishedAt: v.publishedAt,
    }] : [];
  });
}

/**
 * RAG Phase 3, step 3.7 (3) for knowledge: the passages either side of a kept
 * one in the same section (chunk ±1 of the same indexed version), under the
 * same scope and in-force check as the search itself.
 */
export async function knowledgeNeighbours(scope: KnowledgeScope, hits: readonly Pick<KnowledgeHit, "ragDocumentId" | "chunkNo" | "sectionPath">[], now = new Date()): Promise<{ chunkId: string; ragDocumentId: string; chunkNo: number }[]> {
  const wanted = hits.filter((h) => h.sectionPath).flatMap((h) => [h.chunkNo - 1, h.chunkNo + 1].filter((n) => n >= 0).map((n) => ({ h, n })));
  if (!wanted.length || !scope.accessClasses.length) return [];
  const pairs = Prisma.join(wanted.map((w) => Prisma.sql`(${w.h.ragDocumentId}, ${w.n}::int)`), ", ");
  const rows = await prisma.$queryRaw<{ id: string; documentId: string; chunkNo: number; sectionPath: string | null }[]>(Prisma.sql`
    SELECT c."id", c."documentId", c."chunkNo", c."sectionPath" FROM "RagChunk" c
    WHERE ${scopeSql(scope, "c", now)} AND (c."documentId", c."chunkNo") IN (${pairs})`);
  return rows.filter((r) => wanted.some((w) => w.h.ragDocumentId === r.documentId && w.h.sectionPath === r.sectionPath)).map((r) => ({ chunkId: r.id, ragDocumentId: r.documentId, chunkNo: r.chunkNo }));
}
