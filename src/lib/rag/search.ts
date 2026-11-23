import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { RetrievalScope, ScopeSegment } from "./scope";
import { stem } from "./stem";
import { queryTerms, type QueryTerms } from "./queryTerms";
import { QUERY_SCRIPTS, transliterateLatin } from "./romanize";

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

/** Anything that is not part of a word in any of the app's eleven scripts: letters, combining marks, digits and the zero-width (non-)joiner are. */
export const WORD_BREAK = /[^\p{L}\p{M}\p{N}\u200C\u200D]+/u;
const WORD_BREAK_G = new RegExp(WORD_BREAK.source, "gu");

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

/**
 * A word list as an OR tsquery, each word sanitized to letters, combining marks and digits; a stemmed English word matches as a prefix ("allerg:*").
 * RAG Phase 1 fix: Indic vowel signs and viramas are marks (\p{M}), and Telugu/Kannada words carry a zero-width (non-)joiner; dropping them turned
 * "मधुमेह" into "मधमह", which matches nothing (the Indic benchmark: same-script keyword recall 0.18 before the fix).
 */
export function orTsQuery(terms: readonly string[]): string {
  const clean = [...new Set(terms.map((t) => t.toLowerCase().normalize("NFKC").replace(WORD_BREAK_G, "")).filter((t) => t.length > 1))];
  return clean.map((t) => { const s = stem(t); return s !== t ? `${s}:*` : t; }).join(" | ");
}

export const vectorLiteral = (v: readonly number[]) => `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(",")}]`;

export interface CandidateQuery { scope: RetrievalScope; space: EmbeddingSpaceRef; queryVector: number[]; terms: string[]; limit?: number; vectorLimit?: number; keywordLimit?: number;
  /** RAG Phase 3: each keyword matcher's words (queryTerms.ts); from `terms` when not given. */
  keyword?: QueryTerms }

/** RAG Phase 3, step 3.5: the word-similarity threshold for the trigram matcher (pg_trgm's <%), set per transaction. Tuned on the development split. */
export const TRIGRAM_THRESHOLD = 0.4;
let trigramThreshold = TRIGRAM_THRESHOLD;
export function setTrigramThresholdForTest(t: number | null) { trigramThreshold = t ?? TRIGRAM_THRESHOLD; }
/** RAG Phase 3, step 3.10: the weight of a lexicon expansion's match against the question's own words (1), tuned on the development split. */
export const EXPANSION_WEIGHT = 0.5;
let expansionWeight = EXPANSION_WEIGHT;
export function setExpansionWeightForTest(w: number | null) { expansionWeight = w ?? EXPANSION_WEIGHT; }
/** Typing errors in Latin words: strict word similarity (whole-word extents), with its own, stricter threshold. */
export const TYPO_THRESHOLD = 0.6;
export const trigramThresholdSql = () => Prisma.sql`SELECT set_config('pg_trgm.word_similarity_threshold', ${String(trigramThreshold)}, true), set_config('pg_trgm.strict_word_similarity_threshold', ${String(TYPO_THRESHOLD)}, true)`;

const sanitize = (w: string) => w.toLowerCase().normalize("NFKC").replace(WORD_BREAK_G, "");
/** English words as an OR tsquery for the 'english' configuration (it stems them itself). */
const englishTsQuery = (words: readonly string[]) => [...new Set(words.map(sanitize).filter((w) => /^[a-z0-9]{2,}$/.test(w)))].join(" | ");
/** Plain words as an OR tsquery for 'simple', no prefixes (the shadow text's skeletons). */
const plainTsQuery = (words: readonly string[]) => [...new Set(words.map(sanitize).filter((w) => w.length > 1))].join(" | ");

/**
 * RAG Phase 3, step 3.5 — one indexed check before the search decides which
 * of the costlier matchers are worth running:
 *   - the English-stem and typing-error matchers, and transliteration (3.9),
 *     only for Latin words the exact matcher finds nothing for ("allergic"
 *     against "allergy"; "hygene"; "madhumeh"), so a common word isn't ranked
 *     twice or compared with every chunk that already contains it;
 *   - the shadow-text and transliteration matchers only when the scope holds
 *     a chunk with shadow text at all (an English-only record or library
 *     never pays for them; planning two dozen trigram conditions cost ~30 ms).
 * Same scope predicate as the search.
 */
export async function withoutExactLatin(db: Pick<typeof prisma, "$queryRaw">, where: Prisma.Sql, k: QueryTerms, table = "RagChunk"): Promise<QueryTerms> {
  const latin = [...new Set([...k.trigramLatin, ...k.english, ...k.original].map(sanitize).filter((w) => /^[a-z0-9]{2,}$/.test(w)))];
  const T = Prisma.raw(`"${table}"`);
  const rows = await db.$queryRaw<{ w: string | null; shadow: boolean }[]>(Prisma.sql`
    SELECT w, false AS shadow FROM unnest(${latin}::text[]) w WHERE EXISTS (SELECT 1 FROM ${T} c WHERE c."tsv" @@ to_tsquery('simple', w) AND ${where} LIMIT 1)
    UNION ALL SELECT NULL, true WHERE ${k.shadow.length > 0 || k.trigramTranslit.length > 0} AND EXISTS (SELECT 1 FROM ${T} c WHERE c."shadowText" <> '' AND ${where} LIMIT 1)`);
  const have = new Set(rows.filter((r) => r.w).map((r) => r.w!));
  const hasShadow = rows.some((r) => r.shadow);
  const missing = (xs: readonly string[]) => xs.map(sanitize).filter((w) => latin.includes(w) && !have.has(w));
  const translit = k.trigramTranslit.length ? missing(k.original).filter((w) => w.length >= 4 && !/^\d+$/.test(w)).flatMap((w) => QUERY_SCRIPTS.map((sc) => transliterateLatin(w, sc))) : [];
  return {
    ...k, trigramLatin: missing(k.trigramLatin), english: missing(k.english),
    shadow: hasShadow ? k.shadow : [], trigramShadow: hasShadow ? k.trigramShadow : [], trigramTranslit: hasShadow ? translit : [],
  };
}

/**
 * RAG Phase 3, step 3.5 (docs/RAG_ARCHITECTURE.md §6.3) — the keyword channel
 * over chunk `c` admitted by `where`: four matchers, each taking its best
 * `limit`, fused by reciprocal rank (k = 60) into one keyword rank:
 *   exact     the 'simple' tsvector (every language: names, codes, numbers)
 *   english   the English stems column (English chunks only)
 *   shadow    the romanised shadow text, exactly (step 3.9)
 *   trigram   word similarity (pg_trgm <%, GIN-indexed) on the text and the shadow text
 * Returns ("chunkId", rank, score). `table` is for the Indic benchmark's
 * temporary copy of the same columns (scripts/lib/indicBench.ts).
 */
export function keywordSql(where: Prisma.Sql, k: QueryTerms, limit: number, table = "RagChunk"): Prisma.Sql {
  const T = Prisma.raw(`"${table}"`);
  const parts: Prisma.Sql[] = [];
  const tsMatcher = (column: string, config: "simple" | "english", tsq: string, weight: number) => {
    if (!tsq) return;
    const col = Prisma.raw(`c."${column}"`);
    // ts_rank, not ts_rank_cd: over 20,000 matching rows a common word made cover density cost ~50 ms against ~13 (RAG Phase 3 latency gate).
    parts.push(Prisma.sql`(SELECT c."id" AS "chunkId", row_number() OVER (ORDER BY ts_rank(${col}, q) DESC, c."id") AS r, ${weight}::float8 AS w FROM ${T} c, to_tsquery(${config}::regconfig, ${tsq}) q WHERE ${col} @@ q AND ${where} ORDER BY ts_rank(${col}, q) DESC, c."id" LIMIT ${limit})`);
  };
  /** `indicOnly`: only chunks with shadow text (Indic words or a medicine name), the only ones these words can match; keeps an English record's scan cheap. */
  const trigram = (text: readonly string[], shadow: readonly string[], weight: number, indicOnly = false) => {
    const sims = [...text.map((w) => Prisma.sql`word_similarity(${w}, c."text")`), ...shadow.map((w) => Prisma.sql`word_similarity(${w}, coalesce(c."shadowText", ''))`)];
    const ops = [...text.map((w) => Prisma.sql`${w} <% c."text"`), ...shadow.map((w) => Prisma.sql`${w} <% c."shadowText"`)];
    if (!ops.length) return;
    parts.push(Prisma.sql`(SELECT t."chunkId", row_number() OVER (ORDER BY t.sim DESC, t."chunkId") AS r, ${weight}::float8 AS w FROM (
      SELECT c."id" AS "chunkId", greatest(${Prisma.join(sims, ", ")}) AS sim FROM ${T} c WHERE ${indicOnly ? Prisma.sql`c."shadowText" <> '' AND ` : Prisma.empty}(${Prisma.join(ops, " OR ")}) AND ${where}
      ORDER BY sim DESC, c."id" LIMIT ${limit}) t)`);
  };
  // The question's own words (and their abbreviations and medicine names), weight 1. The exact matcher is a CTE: the
  // typing-error matcher scores only its candidates (a misspelt word re-ranks what the other words found; searching
  // the whole table for it cost ~130 ms at 20,000 chunks and rarely found anything new).
  const exactTsq = orTsQuery(k.exact);
  const exactCte = exactTsq
    ? Prisma.sql`SELECT c."id" AS "chunkId", row_number() OVER (ORDER BY ts_rank(c."tsv", q) DESC, c."id") AS r, 1::float8 AS w FROM ${T} c, to_tsquery('simple', ${exactTsq}) q WHERE c."tsv" @@ q AND ${where} ORDER BY ts_rank(c."tsv", q) DESC, c."id" LIMIT ${limit}`
    : Prisma.sql`SELECT NULL::text AS "chunkId", NULL::bigint AS r, 1::float8 AS w WHERE false`;
  parts.push(Prisma.sql`(SELECT * FROM ex)`);
  if (k.trigramLatin.length) {
    const sims = k.trigramLatin.map((w) => Prisma.sql`strict_word_similarity(${w}, c."text")`);
    parts.push(Prisma.sql`(SELECT t."chunkId", row_number() OVER (ORDER BY t.sim DESC, t."chunkId") AS r, 1::float8 AS w FROM (
      SELECT ex."chunkId", greatest(${Prisma.join(sims, ", ")}) AS sim FROM ex JOIN ${T} c ON c."id" = ex."chunkId") t WHERE t.sim >= ${TYPO_THRESHOLD})`);
  }
  tsMatcher("tsvEnglish", "english", englishTsQuery(k.english), 1);
  tsMatcher("tsvShadow", "simple", plainTsQuery(k.shadow), 1);
  trigram([...k.trigramText, ...k.trigramTranslit], k.trigramShadow, 1, true);
  // Step 3.10: the same concept's other names, exactly, weighted below. Not as romanised skeletons or by trigram: a
  // concept's names in related languages romanise alike (madhumeh, madhumeha), so those would match other languages'
  // lines as strongly as the question's own words match its own (found on the held-out split; see the plan's §5.4).
  tsMatcher("tsv", "simple", orTsQuery(k.expansion.exact), expansionWeight);
  return Prisma.sql`WITH ex AS (${exactCte}) SELECT "chunkId", row_number() OVER (ORDER BY s DESC, "chunkId") AS rank, s AS score FROM (
    SELECT u."chunkId", sum(u.w / (60 + u.r)) AS s FROM (${Prisma.join(parts, " UNION ALL ")}) u GROUP BY u."chunkId"
  ) x ORDER BY s DESC, "chunkId" LIMIT ${limit}`;
}

/** The candidate query itself (exported for EXPLAIN in the latency gate). */
export function candidateSql(input: CandidateQuery): Prisma.Sql {
  const where = scopeSql(input.scope);
  // RAG Phase 3, step 3.1: each search's count from the configuration (src/lib/rag/candidates.ts).
  const vectorLimit = input.vectorLimit ?? input.limit ?? 40;
  const keywordLimit = input.keywordLimit ?? input.limit ?? 40;
  const k = input.keyword ?? queryTerms(input.terms.join(" "));
  // The "no record" rule counts the question's own words only, never an expansion.
  const tsq = orTsQuery(k.original);
  const vec = vectorLiteral(input.queryVector);
  return Prisma.sql`
    WITH vec0 AS (
      SELECT e."chunkId", e."embedding" <=> ${vec}::halfvec AS distance
      FROM "RagEmbedding" e
      WHERE e."embeddingModel" = ${input.space.model} AND e."embeddingVersion" = ${input.space.version} AND ${scopeSql(input.scope, "e")}
      ORDER BY distance, e."chunkId"
      LIMIT ${vectorLimit}
    ), vec AS (
      SELECT "chunkId", 1 - distance AS similarity, row_number() OVER (ORDER BY distance, "chunkId") AS rank FROM vec0
    ), kw0 AS (${keywordSql(where, k, keywordLimit)}
    ), kw AS (
      SELECT kw0."chunkId", kw0.score, kw0.rank,
             (SELECT count(*)::int FROM unnest(string_to_array(${tsq}, ' | ')) w WHERE w <> '' AND c."tsv" @@ to_tsquery('simple', w)) AS matched
      FROM kw0 JOIN "RagChunk" c ON c."id" = kw0."chunkId"
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
  const keyword = await withoutExactLatin(prisma, scopeSql(input.scope), input.keyword ?? queryTerms(input.terms.join(" ")));
  input = { ...input, keyword };
  const [, , rows] = await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL plan_cache_mode = force_custom_plan`,
    prisma.$queryRaw(trigramThresholdSql()),
    prisma.$queryRaw<CandidateRow[]>(candidateSql(input)),
  ]);
  return rows.map((r) => ({ chunkId: r.chunkId, vectorRank: r.vectorRank === null ? null : Number(r.vectorRank), similarity: r.similarity, keywordRank: r.keywordRank === null ? null : Number(r.keywordRank), keywordScore: r.keywordScore, matchedTerms: r.matchedTerms ?? 0 }));
}
