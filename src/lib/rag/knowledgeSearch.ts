import { Prisma, type KnowledgeAccessClass, type KnowledgeDocumentType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { knowledgePermit } from "@/lib/ai/realData";
import { activeSpace } from "./embed";
import { cachedKnowledgeEmbeddings } from "./embedCache";
import { orTsQuery, vectorLiteral, WORD_BREAK } from "./search";

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

/** The scope on chunk `c` or embedding `e` (which carries the same filter columns), plus the version in force. */
function scopeSql(s: KnowledgeScope, alias: "c" | "e", now: Date): Prisma.Sql {
  const t = Prisma.raw(alias);
  const chunkId = Prisma.raw(alias === "e" ? `e."chunkId"` : `c."id"`);
  return Prisma.sql`${t}."ownerType" = 'KNOWLEDGE' AND ${t}."status" = 'ACTIVE' AND ${t}."organizationId" = ${s.organizationId}
    AND (${t}."facilityId" IS NULL OR ${t}."facilityId" = ${s.facilityId})
    AND ${t}."accessClass" = ANY(${[...s.accessClasses]}::"KnowledgeAccessClass"[])
    AND EXISTS (SELECT 1 FROM "RagChunk" kc JOIN "RagDocument" kd ON kd."id" = kc."documentId" JOIN "KnowledgeDocumentVersion" kv ON kv."id" = kd."knowledgeVersionId"
      WHERE kc."id" = ${chunkId} AND kd."status" = 'ACTIVE' AND kv."publishedAt" <= ${now}
        AND kv."withdrawnAt" IS NULL AND kv."supersededByVersionId" IS NULL AND (kv."expiresAt" IS NULL OR kv."expiresAt" > ${now}))`;
}

export async function searchKnowledge(scope: KnowledgeScope, question: string, opts: { limit?: number; now?: Date; vectorLimit?: number; keywordLimit?: number } = {}): Promise<KnowledgeHit[]> {
  if (!scope.accessClasses.length) return [];
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 8;
  const space = await activeSpace();
  const { vectors } = await cachedKnowledgeEmbeddings(space, [question], knowledgePermit(scope.organizationId));
  const tsq = orTsQuery(question.split(WORD_BREAK));
  const rows = await prisma.$queryRaw<{ chunkId: string; score: number }[]>`
    WITH vec AS (
      SELECT e."chunkId", row_number() OVER (ORDER BY e."embedding" <=> ${vectorLiteral(vectors[0])}::halfvec, e."chunkId") AS rank
      FROM "RagEmbedding" e
      WHERE e."embeddingModel" = ${space.embeddingModel} AND e."embeddingVersion" = ${space.embeddingVersion} AND ${scopeSql(scope, "e", now)}
      ORDER BY e."embedding" <=> ${vectorLiteral(vectors[0])}::halfvec, e."chunkId" LIMIT ${opts.vectorLimit ?? 40}
    ), kw AS (
      SELECT c."id" AS "chunkId", row_number() OVER (ORDER BY ts_rank_cd(c."tsv", q) DESC, c."id") AS rank
      FROM "RagChunk" c, to_tsquery('simple', ${tsq || "x"}) q
      WHERE ${tsq !== ""} AND c."tsv" @@ q AND ${scopeSql(scope, "c", now)}
      ORDER BY ts_rank_cd(c."tsv", q) DESC, c."id" LIMIT ${opts.keywordLimit ?? 40}
    )
    SELECT coalesce(vec."chunkId", kw."chunkId") AS "chunkId",
           coalesce(1.0 / (60 + vec.rank), 0) + coalesce(1.0 / (60 + kw.rank), 0) AS score
    FROM vec FULL OUTER JOIN kw ON kw."chunkId" = vec."chunkId"
    ORDER BY score DESC, "chunkId" LIMIT ${limit}`;
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
