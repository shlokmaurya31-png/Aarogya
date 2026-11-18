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
export async function indicMethods(tx: Prisma.TransactionClient, corpus: BenchDoc[], models: ModelVectors[] = []): Promise<[string, Ranker][]> {
  await tx.$executeRawUnsafe(`CREATE TEMP TABLE bench_doc ("id" text PRIMARY KEY, "lang" text, "text" text, "tsv" tsvector GENERATED ALWAYS AS (to_tsvector('simple', "text")) STORED) ON COMMIT DROP`);
  for (const d of corpus) await tx.$executeRaw`INSERT INTO bench_doc ("id", "lang", "text") VALUES (${d.id}, ${d.lang}, ${d.text})`;
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
  ];
  for (const m of models) {
    const mv = vectorRanker(new Map(Object.entries(m.docs)), (q) => m.queries[q.id]);
    methods.push([`${m.model} vector`, mv]);
    methods.push([`hybrid (${m.model})`, async (q) => fuse([await keyword(q), await trigram(q), await mv(q)]).slice(0, 10)]);
  }
  return methods;
}
