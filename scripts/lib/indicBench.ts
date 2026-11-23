/**
 * RAG Phase 1, step 1.9 — the Indic benchmark's methods, shared by the report
 * (scripts/eval-rag-indic.ts) and the CI gate (verify-postgres-rag-indic).
 * Every method is built as production builds it; the database part runs on
 * temporary tables inside the caller's transaction (nothing is written).
 */
import { Prisma } from "@prisma/client";
import type { BenchDoc, BenchQuery } from "../../eval/rag/indic/dataset";
import { orTsQuery } from "../../src/lib/rag/search";
import { contentWords } from "../../src/lib/ai/record/mock";
import { hashEmbed, tokens } from "../../src/lib/ai/embeddings/mock";
import { keywordSql, trigramThresholdSql, withoutExactLatin } from "../../src/lib/rag/search";
import { queryTerms, type QueryFeatures } from "../../src/lib/rag/queryTerms";
import { shadowTextFor } from "../../src/lib/rag/shadow";

export const RRF_K = 60;
export const TRIGRAM_MIN = 0.3;
export type Ranker = (q: BenchQuery) => Promise<string[]>;
export interface ModelVectors { model: string; dims: number; docs: Record<string, number[]>; queries: Record<string, number[]>; queryLatencyMs?: { p50: number; p95: number }; resources?: Record<string, string | number> }

const cosine = (a: number[], b: number[]) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return x && y ? d / Math.sqrt(x * y) : 0; };
export const fuse = (lists: string[][]) => {
  const score = new Map<string, number>();
  for (const l of lists) l.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + i + 1)));
  return [...score].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id);
};

/** The methods over `corpus`, on temporary tables in transaction `tx`. */
/** RAG Phase 3: the steps measured, each on its own and together (production's keyword channel, src/lib/rag/search.ts keywordSql). */
export const PHASE3_METHODS: [string, QueryFeatures][] = [
  ["3.5 keyword (exact, English, abbreviations, trigram)", { abbreviations: true, medicines: true, trigram: true, shadow: false, lexicon: false }],
  ["3.5 + 3.9 (romanised shadow, transliteration)", { abbreviations: true, medicines: true, trigram: true, shadow: true, lexicon: false }],
  ["3.5 + 3.10 (concept lexicon)", { abbreviations: true, medicines: true, trigram: true, shadow: false, lexicon: true }],
  ["3.5 + 3.9 + 3.10", { abbreviations: true, medicines: true, trigram: true, shadow: true, lexicon: true }],
];

export async function indicMethods(tx: Prisma.TransactionClient, corpus: BenchDoc[], models: ModelVectors[] = []): Promise<[string, Ranker][]> {
  await tx.$executeRawUnsafe(`CREATE TEMP TABLE bench_doc ("id" text PRIMARY KEY, "lang" text, "text" text, "tsv" tsvector GENERATED ALWAYS AS (to_tsvector('simple', "text")) STORED) ON COMMIT DROP`);
  for (const d of corpus) await tx.$executeRaw`INSERT INTO bench_doc ("id", "lang", "text") VALUES (${d.id}, ${d.lang}, ${d.text})`;
  // The same columns as RagChunk's, filled as the indexer fills them (the shadow text by shadowTextFor).
  await tx.$executeRawUnsafe(`CREATE TEMP TABLE bench_chunk ("id" text PRIMARY KEY, "language" text, "context" text, "heading" text, "text" text, "shadowText" text,
    "tsv" tsvector GENERATED ALWAYS AS (to_tsvector('simple', "text")) STORED,
    "tsvEnglish" tsvector GENERATED ALWAYS AS (CASE WHEN "language" = 'en' THEN to_tsvector('english', "text") ELSE NULL END) STORED,
    "tsvShadow" tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce("shadowText", ''))) STORED) ON COMMIT DROP`);
  for (const d of corpus) await tx.$executeRaw`INSERT INTO bench_chunk ("id", "language", "text", "shadowText") VALUES (${d.id}, ${d.lang}, ${d.text}, ${shadowTextFor({ text: d.text })})`;
  await tx.$queryRaw(trigramThresholdSql());
  const production = (f: QueryFeatures): Ranker => async (q) => {
    const k = await withoutExactLatin(tx, Prisma.sql`true`, queryTerms(q.text, f), "bench_chunk");
    const rows = await tx.$queryRaw<{ chunkId: string }[]>(Prisma.sql`SELECT "chunkId" FROM (${keywordSql(Prisma.sql`true`, k, 10, "bench_chunk")}) x ORDER BY rank`);
    return rows.map((r) => r.chunkId);
  };
  const keyword: Ranker = async (q) => {
    const tsq = orTsQuery(contentWords(q.text));
    if (!tsq) return [];
    const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT "id" FROM bench_doc, to_tsquery('simple', ${tsq}) q WHERE "tsv" @@ q ORDER BY ts_rank_cd("tsv", q) DESC, "id" LIMIT 10`);
    return rows.map((r) => r.id);
  };
  const trigram: Ranker = async (q) => {
    const words = [...new Set(tokens(q.text).filter((w) => w.length > 1))];
    if (!words.length) return [];
    const rows = await tx.$queryRaw<{ id: string; s: number }[]>(Prisma.sql`
      SELECT "id", max(word_similarity(w, "text")) AS s FROM bench_doc, unnest(${words}::text[]) w
      GROUP BY "id" HAVING max(word_similarity(w, "text")) >= ${TRIGRAM_MIN} ORDER BY s DESC, "id" LIMIT 10`);
    return rows.map((r) => r.id);
  };
  const vectorRanker = (docVecs: Map<string, number[]>, queryVec: (q: BenchQuery) => number[]): Ranker => async (q) => {
    const v = queryVec(q);
    return [...docVecs].map(([id, d]) => [id, cosine(v, d)] as const).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10).map(([id]) => id);
  };
  const mockVector = vectorRanker(new Map(corpus.map((d) => [d.id, hashEmbed(d.text, 1024)])), (q) => hashEmbed(q.text, 1024));
  const methods: [string, Ranker][] = [
    ["keyword", keyword],
    ["trigram", trigram],
    ["keyword+trigram", async (q) => fuse([await keyword(q), await trigram(q)]).slice(0, 10)],
    ["mock vector", mockVector],
    ["hybrid (mock)", async (q) => fuse([await keyword(q), await trigram(q), await mockVector(q)]).slice(0, 10)],
    ...PHASE3_METHODS.map(([name, f]) => [name, production(f)] as [string, Ranker]),
  ];
  for (const m of models) {
    // Only this corpus's documents (a vectors file may hold both splits).
    const ids = new Set(corpus.map((d) => d.id));
    const mv = vectorRanker(new Map(Object.entries(m.docs).filter(([id]) => ids.has(id))), (q) => m.queries[q.id]);
    methods.push([`${m.model} vector`, mv]);
    methods.push([`hybrid (${m.model})`, async (q) => fuse([await keyword(q), await trigram(q), await mv(q)]).slice(0, 10)]);
  }
  return methods;
}
