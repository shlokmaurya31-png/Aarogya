import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { RetrievalScope, ScopeSegment } from "./scope";
import { stem } from "./stem";

/**
 * Week 4b — candidate search over the index (docs/RAG_DESIGN.md §7.1–§7.2):
 * the access scope as a SQL predicate on the chunk being ranked, then, in one
 * round trip, the 40 nearest chunks by exact cosine distance in the active
 * embedding space (half-precision vectors, distances computed exactly) and
 * the 40 best keyword matches (ts_rank_cd). No ANN index:
 * a request is about one patient, so this is a scan over that patient's rows
 * (the latency gate holds it under 150 ms at p95 for 20,000 chunks).
 */
export interface Candidate { chunkId: string; vectorRank: number | null; similarity: number | null; keywordRank: number | null; keywordScore: number | null; matchedTerms: number }

export interface EmbeddingSpaceRef { model: string; version: number }

function segmentSql(seg: ScopeSegment, t: Prisma.Sql): Prisma.Sql | null {
  const owner: Prisma.Sql[] = [];
  if (seg.facility && seg.facility.patientIds.length && seg.facility.facilityIds.length) {
    owner.push(Prisma.sql`(${t}."ownerType" = 'FACILITY_PATIENT' AND ${t}."patientId" = ANY(${seg.facility.patientIds}::text[]) AND ${t}."facilityId" = ANY(${seg.facility.facilityIds}::text[]))`);
  }
  if (seg.personId) owner.push(Prisma.sql`(${t}."ownerType" = 'PERSON' AND ${t}."personId" = ${seg.personId})`);
  if (!owner.length || !seg.categories.length || !seg.audiences.length || !seg.origins.length) return null;
  const parts: Prisma.Sql[] = [
    Prisma.sql`(${Prisma.join(owner, " OR ")})`,
    Prisma.sql`${t}."categories" <@ ${seg.categories}::"RagCategory"[]`,
    seg.sensitive.length ? Prisma.sql`(${t}."sensitiveCategory" IS NULL OR ${t}."sensitiveCategory" = ANY(${seg.sensitive}::"RagSensitiveCategory"[]))` : Prisma.sql`${t}."sensitiveCategory" IS NULL`,
    Prisma.sql`${t}."audience" = ANY(${seg.audiences}::"RagAudience"[])`,
    Prisma.sql`${t}."origin" = ANY(${seg.origins}::"RagOrigin"[])`,
  ];
  if (seg.recordedFrom) parts.push(Prisma.sql`${t}."recordedAt" >= ${seg.recordedFrom}`);
  if (seg.recordedTo) parts.push(Prisma.sql`${t}."recordedAt" <= ${seg.recordedTo}`);
  if (seg.sourceIds) parts.push(seg.sourceIds.length ? Prisma.sql`${t}."sourceId" = ANY(${seg.sourceIds}::text[])` : Prisma.sql`false`);
  return Prisma.sql`(${Prisma.join(parts, " AND ")})`;
}

/**
 * The scope as one predicate (ACTIVE only; `false` when nothing is admitted),
 * on chunk `c` — or on embedding `e`, which carries the same filter columns
 * (copied from its chunk by a trigger), so the vector search never joins.
 */
export function scopeSql(scope: RetrievalScope, alias: "c" | "e" = "c"): Prisma.Sql {
  const t = Prisma.raw(alias);
  const segs = scope.segments.map((g) => segmentSql(g, t)).filter((x): x is Prisma.Sql => x !== null);
  return segs.length ? Prisma.sql`${t}."status" = 'ACTIVE' AND (${Prisma.join(segs, " OR ")})` : Prisma.sql`false`;
}

/** A word list as an OR tsquery, each word sanitized to letters and digits; a stemmed English word matches as a prefix ("allerg:*"). */
export function orTsQuery(terms: readonly string[]): string {
  const clean = [...new Set(terms.map((t) => t.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "")).filter((t) => t.length > 1))];
  return clean.map((t) => { const s = stem(t); return s !== t ? `${s}:*` : t; }).join(" | ");
}

export const vectorLiteral = (v: readonly number[]) => `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(",")}]`;

export interface CandidateQuery { scope: RetrievalScope; space: EmbeddingSpaceRef; queryVector: number[]; terms: string[]; limit?: number }

/** The candidate query itself (exported for EXPLAIN in the latency gate). */
export function candidateSql(input: CandidateQuery): Prisma.Sql {
  const where = scopeSql(input.scope);
  const limit = input.limit ?? 40;
  const tsq = orTsQuery(input.terms);
  const vec = vectorLiteral(input.queryVector);
  return Prisma.sql`
    WITH vec0 AS (
      SELECT e."chunkId", e."embedding" <=> ${vec}::halfvec AS distance
      FROM "RagEmbedding" e
      WHERE e."embeddingModel" = ${input.space.model} AND e."embeddingVersion" = ${input.space.version} AND ${scopeSql(input.scope, "e")}
      ORDER BY distance, e."chunkId"
      LIMIT ${limit}
    ), vec AS (
      SELECT "chunkId", 1 - distance AS similarity, row_number() OVER (ORDER BY distance, "chunkId") AS rank FROM vec0
    ), kw0 AS (
      SELECT c."id" AS "chunkId", c."tsv", ts_rank_cd(c."tsv", q) AS score,
             row_number() OVER (ORDER BY ts_rank_cd(c."tsv", q) DESC, c."id") AS rank
      FROM "RagChunk" c, to_tsquery('simple', ${tsq || "x"}) q
      WHERE ${tsq !== ""} AND c."tsv" @@ q AND ${where}
      ORDER BY score DESC, c."id"
      LIMIT ${limit}
    ), kw AS (
      SELECT kw0."chunkId", kw0.score, kw0.rank,
             (SELECT count(*)::int FROM unnest(string_to_array(${tsq}, ' | ')) w WHERE w <> '' AND kw0."tsv" @@ to_tsquery('simple', w)) AS matched
      FROM kw0
    )
    SELECT coalesce(vec."chunkId", kw."chunkId") AS "chunkId", vec.rank AS "vectorRank", vec.similarity, kw.rank AS "keywordRank", kw.score AS "keywordScore", kw.matched AS "matchedTerms"
    FROM vec FULL OUTER JOIN kw ON kw."chunkId" = vec."chunkId"`;
}

type CandidateRow = { chunkId: string; vectorRank: bigint | null; similarity: number | null; keywordRank: bigint | null; keywordScore: number | null; matchedTerms: number | null };

/**
 * Exact-cosine and keyword candidates in the scope, fused later (retrieve.ts).
 * Planned for its own parameters every time (SET LOCAL, this transaction
 * only): after five runs Postgres would otherwise switch the prepared
 * statement to a generic plan, ~100× slower for this query (found by the
 * latency gate).
 */
export async function candidateSearch(input: CandidateQuery): Promise<Candidate[]> {
  const [, rows] = await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL plan_cache_mode = force_custom_plan`,
    prisma.$queryRaw<CandidateRow[]>(candidateSql(input)),
  ]);
  return rows.map((r) => ({ chunkId: r.chunkId, vectorRank: r.vectorRank === null ? null : Number(r.vectorRank), similarity: r.similarity, keywordRank: r.keywordRank === null ? null : Number(r.keywordRank), keywordScore: r.keywordScore, matchedTerms: r.matchedTerms ?? 0 }));
}
