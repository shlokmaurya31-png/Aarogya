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
import { buildDevCorpus, buildDevQueries } from "../eval/rag/indic/devDataset";
import type { ModelVectors } from "./lib/indicBench";

const DEFAULT_VERIFY_URL = "postgresql://aarogya:aarogya@localhost:5432/aarogya_verify";
const REPORTS = path.resolve(__dirname, "..", ".eval-report");
const KINDS: QueryKind[] = ["SAME_SCRIPT", "INFLECTED", "TRANSLITERATED", "MIXED_SCRIPT", "CROSS_SCRIPT", "MEDICINE_LATIN"];


const arg = (name: string) => process.argv.flatMap((a, i) => (a === name ? [process.argv[i + 1]] : []));
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : NaN; };

/** RAG Phase 1's figures on this set for BGE-M3 (vector), Recall@5 (Recall@10 for cross-script): shown when no vectors file is given. */
const BGE_M3_PHASE1 = { SAME_SCRIPT: "1.00", INFLECTED: "1.00", TRANSLITERATED: "0.80", CROSS_SCRIPT: "0.38 (@10 0.60)" };

async function main() {
  // RAG Phase 3: the Phase 1 set is the held-out TEST split; the development split (new topics) is the only one tuned on.
  const sets = [
    { key: "test", title: "Held-out test split — the Phase 1 set (diabetes, hypertension, asthma, fever); never tuned on", corpus: buildCorpus(), queries: buildQueries() },
    { key: "dev", title: "Development split — cough, jaundice, vomiting, headache (steps 3.9 and 3.10 and the trigram threshold tuned here)", corpus: buildDevCorpus(), queries: buildDevQueries() },
  ];
  for (const f of arg("--dump")) {
    writeFileSync(f, JSON.stringify({ docs: sets.flatMap((x) => x.corpus).map((d) => ({ id: d.id, text: d.text })), queries: sets.flatMap((x) => x.queries).map((q) => ({ id: q.id, text: q.text })) }, null, 1));
    console.log(`Wrote the corpus (${sets.reduce((n, x) => n + x.corpus.length, 0)}) and queries (${sets.reduce((n, x) => n + x.queries.length, 0)}) of both splits to ${f}`);
    return;
  }
  const url = process.env.VERIFY_DATABASE_URL || DEFAULT_VERIFY_URL;
  if (!["localhost", "127.0.0.1", "::1"].includes(new URL(url).hostname)) throw new Error("eval:rag:indic runs only against a local verify database.");
  process.env.DATABASE_URL = url;
  process.env.DIRECT_URL = url;
  const { prisma } = await import("../src/lib/db");
  const { indicMethods, PHASE3_METHODS } = await import("./lib/indicBench");
  const { summarize } = await import("../src/lib/rag/metrics");
  const models: ModelVectors[] = arg("--vectors").map((f) => JSON.parse(readFileSync(f, "utf8")));
  const f2 = (x: number) => x.toFixed(2);
  const lines: string[] = [
    "# Indic retrieval benchmark (RAG Phase 1, step 1.9; Phase 3, steps 3.9 and 3.10)", "",
    `- Date: ${new Date().toISOString()}`,
    "- Data: eval/rag/indic/dataset.ts (test) and devDataset.ts (development) — **written by the team, not reviewed by native speakers or a clinician**; synthetic only",
    "- Database: local verify database, temporary tables in one transaction per split (nothing written)",
    "- Caveat: each split is 44 short lines: this measures whether a method can match at all, not ranking at scale. The concept lexicon's common conditions include the test set's four (they are among the commonest), written independently of the test words; see the report for what that means.",
    "",
  ];
  for (const m of models) lines.push(`- ${m.model}: ${m.dims} dimensions; query embedding p50 ${m.queryLatencyMs?.p50 ?? "?"} ms, p95 ${m.queryLatencyMs?.p95 ?? "?"} ms; ${Object.entries(m.resources ?? {}).map(([k, v]) => `${k} ${v}`).join("; ")}`);
  if (models.length) lines.push("");
  const summary: string[] = [];
  for (const set of sets) {
    const latency = new Map<string, number[]>();
    const results = new Map<string, Map<string, string[]>>();
    await prisma.$transaction(async (tx) => {
      const methods = await indicMethods(tx, set.corpus, models);
      for (const [name, rank] of methods) {
        const out = new Map<string, string[]>();
        const times: number[] = [];
        for (const q of set.queries) {
          const t0 = performance.now();
          out.set(q.id, await rank(q));
          times.push(performance.now() - t0);
        }
        results.set(name, out);
        latency.set(name, times);
      }
    }, { timeout: 300_000 });
    const judge = (method: string, qs: BenchQuery[]) => qs.map((q) => ({ ranked: results.get(method)!.get(q.id) ?? [], relevant: (id: string) => q.relevant.includes(id), totalRelevant: q.relevant.length }));
    const methodNames = [...results.keys()];
    const kinds = KINDS.filter((k) => set.queries.some((q) => q.kind === k));
    lines.push(`## ${set.title}`, "", `${set.corpus.length} lines, ${set.queries.length} queries. Recall@5 / Recall@10 / MRR / nDCG@10:`, "");
    lines.push(`| Method | ${kinds.join(" | ")} | All |`, `|---|${kinds.map(() => "---").join("|")}|---|`);
    for (const name of methodNames) {
      const cells = kinds.map((k) => {
        const qs = set.queries.filter((q) => q.kind === k);
        const s5 = summarize(judge(name, qs), 5), s10 = summarize(judge(name, qs), 10);
        return `${f2(s5.recall)} / ${f2(s10.recall)} / ${f2(s5.mrr)} / ${f2(s5.ndcg)} (n=${qs.length})`;
      });
      const all = summarize(judge(name, set.queries), 5);
      lines.push(`| ${name} | ${cells.join(" | ")} | ${f2(all.recall)} / ${f2(summarize(judge(name, set.queries), 10).recall)} / ${f2(all.mrr)} / ${f2(all.ndcg)} |`);
    }
    lines.push("", "Recall@5 by language:", "", `| Method | ${LANGUAGES.join(" | ")} |`, `|---|${LANGUAGES.map(() => "---").join("|")}|`);
    for (const name of methodNames) lines.push(`| ${name} | ${LANGUAGES.map((l) => f2(summarize(judge(name, set.queries.filter((q) => q.lang === l)), 5).recall)).join(" | ")} |`);
    lines.push("", "Query latency on this corpus (ms):", "", "| Method | p50 | p95 |", "|---|---|---|");
    for (const name of methodNames) lines.push(`| ${name} | ${pct(latency.get(name)!, 50).toFixed(2)} | ${pct(latency.get(name)!, 95).toFixed(2)} |`);
    lines.push("");
    // The comparison the plan asks for: Phase 1 keyword, 3.9, 3.10, both, and BGE-M3, Recall@5 (cross-script @10 too).
    const r5 = (name: string, k: QueryKind) => { const qs = set.queries.filter((q) => q.kind === k); return qs.length && results.has(name) ? f2(summarize(judge(name, qs), 5).recall) : "—"; };
    const r10 = (name: string, k: QueryKind) => { const qs = set.queries.filter((q) => q.kind === k); return qs.length && results.has(name) ? f2(summarize(judge(name, qs), 10).recall) : "—"; };
    const rows: [string, string][] = [["Phase 1: keyword + trigram", "keyword+trigram"], ...PHASE3_METHODS.map(([n]) => [n, n] as [string, string])];
    const bge = models.find((m) => /bge-m3/i.test(m.model));
    summary.push(`### ${set.key === "test" ? "Held-out test split" : "Development split"}`, "", "| Method | Same script | Inflected | Transliterated | Cross-script (@5 / @10) | Medicine in Latin |", "|---|---|---|---|---|---|");
    for (const [label, name] of rows) summary.push(`| ${label} | ${r5(name, "SAME_SCRIPT")} | ${r5(name, "INFLECTED")} | ${r5(name, "TRANSLITERATED")} | ${r5(name, "CROSS_SCRIPT")} / ${r10(name, "CROSS_SCRIPT")} | ${r5(name, "MEDICINE_LATIN")} |`);
    if (bge) summary.push(`| ${bge.model} vector (re-run here) | ${r5(`${bge.model} vector`, "SAME_SCRIPT")} | ${r5(`${bge.model} vector`, "INFLECTED")} | ${r5(`${bge.model} vector`, "TRANSLITERATED")} | ${r5(`${bge.model} vector`, "CROSS_SCRIPT")} / ${r10(`${bge.model} vector`, "CROSS_SCRIPT")} | ${r5(`${bge.model} vector`, "MEDICINE_LATIN")} |`);
    else if (set.key === "test") summary.push(`| BGE-M3 vector (Phase 1 run, not re-run) | ${BGE_M3_PHASE1.SAME_SCRIPT} | ${BGE_M3_PHASE1.INFLECTED} | ${BGE_M3_PHASE1.TRANSLITERATED} | ${BGE_M3_PHASE1.CROSS_SCRIPT} | 0.42 |`);
    summary.push("");
  }
  if (!models.length) lines.push("Real models: **pending** for this run — no vectors file given (see scripts/indic-embed.py). Voyage: pending (no VOYAGE_API_KEY).", "");
  const md = [lines[0], "", "## Summary: steps 3.9 and 3.10, Recall@5", "", ...summary, ...lines.slice(1)].join("\n") + "\n";
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
