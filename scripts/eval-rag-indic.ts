/**
 * RAG Phase 1, step 1.9 — npm run eval:rag:indic [-- --vectors <file> ...] [--dump <file>]
 *
 * The Indic retrieval benchmark (ADR 0005 part A): a synthetic corpus and
 * queries in the app's eleven languages (eval/rag/indic/dataset.ts) —
 * same-script, inflected, transliterated, mixed-script, cross-script, and the
 * medicine typed in Latin — scored with Recall@5, Recall@10, MRR and nDCG@10,
 * per method, per kind of query and per language, with query latency.
 *
 * Methods, all as production builds them:
 *   keyword          the "simple" tsvector and the OR query of src/lib/rag/search.ts
 *   trigram          pg_trgm word similarity of each query word (RAG Phase 1)
 *   keyword+trigram  the two, fused by reciprocal rank
 *   mock vector      the offline embedding (feature hashing, 1024 dimensions)
 *   hybrid (mock)    keyword, trigram and the mock vector, fused (k = 60)
 *   <model> vector / hybrid (<model>)   for each --vectors file: vectors made by
 *                    a real model (scripts/indic-embed.py), the same fusion
 *
 * Runs against the LOCAL verify database only, inside one transaction on
 * temporary tables: nothing is written. Synthetic data only; no provider is
 * called by this script. --dump writes the corpus and queries as JSON for an
 * external embedder. Writes .eval-report/rag-indic-<time>.md and rag-indic-latest.md.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildCorpus, buildQueries, LANGUAGES, type BenchDoc, type BenchQuery, type QueryKind } from "../eval/rag/indic/dataset";
import type { ModelVectors } from "./lib/indicBench";

const DEFAULT_VERIFY_URL = "postgresql://aarogya:aarogya@localhost:5432/aarogya_verify";
const REPORTS = path.resolve(__dirname, "..", ".eval-report");
const KINDS: QueryKind[] = ["SAME_SCRIPT", "INFLECTED", "TRANSLITERATED", "MIXED_SCRIPT", "CROSS_SCRIPT", "MEDICINE_LATIN"];


const arg = (name: string) => process.argv.flatMap((a, i) => (a === name ? [process.argv[i + 1]] : []));
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : NaN; };

async function main() {
  const corpus = buildCorpus();
  const queries = buildQueries();
  for (const f of arg("--dump")) {
    writeFileSync(f, JSON.stringify({ docs: corpus.map((d) => ({ id: d.id, text: d.text })), queries: queries.map((q) => ({ id: q.id, text: q.text })) }, null, 1));
    console.log(`Wrote the corpus (${corpus.length}) and queries (${queries.length}) to ${f}`);
    return;
  }
  const url = process.env.VERIFY_DATABASE_URL || DEFAULT_VERIFY_URL;
  if (!["localhost", "127.0.0.1", "::1"].includes(new URL(url).hostname)) throw new Error("eval:rag:indic runs only against a local verify database.");
  process.env.DATABASE_URL = url;
  process.env.DIRECT_URL = url;
  const { prisma } = await import("../src/lib/db");
  const { indicMethods } = await import("./lib/indicBench");
  const { summarize } = await import("../src/lib/rag/metrics");
  const models: ModelVectors[] = arg("--vectors").map((f) => JSON.parse(readFileSync(f, "utf8")));

  const latency = new Map<string, number[]>();
  const results = new Map<string, Map<string, string[]>>();

  await prisma.$transaction(async (tx) => {
    // Temporary tables, this transaction only: the verify database is not changed.
    const methods = await indicMethods(tx, corpus, models);
    for (const [name, rank] of methods) {
      const out = new Map<string, string[]>();
      const times: number[] = [];
      for (const q of queries) {
        const t0 = performance.now();
        out.set(q.id, await rank(q));
        times.push(performance.now() - t0);
      }
      results.set(name, out);
      latency.set(name, times);
    }
  }, { timeout: 300_000 });

  // ── scoring ──
  const judge = (method: string, qs: BenchQuery[]) => qs.map((q) => ({ ranked: results.get(method)!.get(q.id)!, relevant: (id: string) => q.relevant.includes(id), totalRelevant: q.relevant.length }));
  const f2 = (x: number) => x.toFixed(2);
  const methodNames = [...results.keys()];
  const lines: string[] = [
    "# Indic retrieval benchmark (RAG Phase 1, step 1.9)", "",
    `- Date: ${new Date().toISOString()}`,
    `- Corpus: ${corpus.length} synthetic clinical lines (4 conditions × 11 languages); ${queries.length} queries; one relevant line per query`,
    "- Data: eval/rag/indic/dataset.ts — **written by the team, not reviewed by native speakers or a clinician**; synthetic only",
    "- Database: local verify database, temporary tables in one transaction (nothing written)",
    "- Caveat: a 44-line corpus measures whether each method can match at all, not ranking at scale; latency here is per query on this tiny corpus, not production latency (the production latency gate is verify-postgres-rag-latency)",
    "",
  ];
  for (const m of models) lines.push(`- ${m.model}: ${m.dims} dimensions; query embedding p50 ${m.queryLatencyMs?.p50 ?? "?"} ms, p95 ${m.queryLatencyMs?.p95 ?? "?"} ms; ${Object.entries(m.resources ?? {}).map(([k, v]) => `${k} ${v}`).join("; ")}`);
  if (models.length) lines.push("");
  lines.push("## By method and kind of query (Recall@5 / Recall@10 / MRR / nDCG@10)", "");
  lines.push(`| Method | ${KINDS.join(" | ")} | All |`, `|---|${KINDS.map(() => "---").join("|")}|---|`);
  const all: Record<string, ReturnType<typeof summarize>> = {};
  for (const name of methodNames) {
    const cells = KINDS.map((k) => {
      const qs = queries.filter((q) => q.kind === k);
      const s5 = summarize(judge(name, qs), 5), s10 = summarize(judge(name, qs), 10);
      return `${f2(s5.recall)} / ${f2(s10.recall)} / ${f2(s5.mrr)} / ${f2(s5.ndcg)} (n=${qs.length})`;
    });
    all[name] = summarize(judge(name, queries), 5);
    lines.push(`| ${name} | ${cells.join(" | ")} | ${f2(all[name].recall)} / ${f2(summarize(judge(name, queries), 10).recall)} / ${f2(all[name].mrr)} / ${f2(all[name].ndcg)} |`);
  }
  lines.push("", "## By language: Recall@5 over that language's queries", "", `| Method | ${LANGUAGES.join(" | ")} |`, `|---|${LANGUAGES.map(() => "---").join("|")}|`);
  for (const name of methodNames) lines.push(`| ${name} | ${LANGUAGES.map((l) => f2(summarize(judge(name, queries.filter((q) => q.lang === l)), 5).recall)).join(" | ")} |`);
  lines.push("", "## Query latency on this corpus (ms)", "", "| Method | p50 | p95 |", "|---|---|---|");
  for (const name of methodNames) lines.push(`| ${name} | ${pct(latency.get(name)!, 50).toFixed(2)} | ${pct(latency.get(name)!, 95).toFixed(2)} |`);
  if (!models.length) lines.push("", "Real models: **pending** — no vectors file given (see scripts/indic-embed.py). Voyage: pending (no VOYAGE_API_KEY).");
  const md = lines.join("\n") + "\n";
  mkdirSync(REPORTS, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(path.join(REPORTS, `rag-indic-${stamp}.md`), md);
  writeFileSync(path.join(REPORTS, "rag-indic-latest.md"), md);
  console.log(md);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

export type { BenchDoc };
