import "./lib/gateBootstrap";
/**
 * RAG Phase 1, step 1.9 — the Indic benchmark on the offline methods, in CI
 * (docs/RAG_IMPLEMENTATION_PLAN.md §3; ADR 0005 part A). The floors are the
 * values measured on 2026-11-17 after the tokeniser fix, so they only move up:
 *
 *   same-script, keyword            Recall@5 = 1.00 (was 0.18: Indic vowel signs were
 *                                   dropped from query words; RAG Phase 1 fix)
 *   inflected, keyword+trigram      Recall@5 ≥ 0.80 (measured 0.81)
 *   same-script, keyword+trigram    Recall@5 = 1.00
 *   mixed-script, keyword+trigram   Recall@5 ≥ 0.80 (measured 0.85)
 *   every language, same-script keyword: each of the eleven finds its own line
 *
 * Transliterated and cross-script queries need a multilingual model: they are
 * reported by `npm run eval:rag:indic`, not floored here. Temporary tables
 * in one transaction: nothing is written.
 *
 * Usage: through `npm run verify:all`.
 */
import { prisma } from "../src/lib/db";
import { summarize } from "../src/lib/rag/metrics";
import { buildCorpus, buildQueries, LANGUAGES, type BenchQuery, type QueryKind } from "../eval/rag/indic/dataset";
import { indicMethods } from "./lib/indicBench";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

async function main() {
  const corpus = buildCorpus();
  const queries = buildQueries();
  const ranked = new Map<string, Map<string, string[]>>();
  await prisma.$transaction(async (tx) => {
    for (const [name, rank] of await indicMethods(tx, corpus)) {
      if (name !== "keyword" && name !== "keyword+trigram") continue;
      const m = new Map<string, string[]>();
      for (const q of queries) m.set(q.id, await rank(q));
      ranked.set(name, m);
    }
  }, { timeout: 120_000 });
  const recall = (method: string, pick: (q: BenchQuery) => boolean) => {
    const qs = queries.filter(pick);
    return summarize(qs.map((q) => ({ ranked: ranked.get(method)!.get(q.id)!, relevant: (id: string) => q.relevant.includes(id), totalRelevant: 1 })), 5).recall;
  };
  const kind = (k: QueryKind) => (q: BenchQuery) => q.kind === k;
  const f = (x: number) => x.toFixed(2);
  const r1 = recall("keyword", kind("SAME_SCRIPT"));
  report("Same-script words, keyword: Recall@5 = 1.00 (vowel signs and joiners kept)", r1 === 1, f(r1));
  for (const lang of LANGUAGES) {
    const r = recall("keyword", (q) => q.kind === "SAME_SCRIPT" && q.lang === lang);
    report(`  ${lang}: every same-script line found by keyword`, r === 1, f(r));
  }
  const r2 = recall("keyword+trigram", kind("SAME_SCRIPT"));
  report("Same-script, keyword+trigram: Recall@5 = 1.00", r2 === 1, f(r2));
  const r3 = recall("keyword+trigram", kind("INFLECTED"));
  report("Inflected Indic words (base form asked), keyword+trigram: Recall@5 ≥ 0.80", r3 >= 0.8, f(r3));
  const r4 = recall("keyword+trigram", kind("MIXED_SCRIPT"));
  report("Mixed-script (Indic word + Latin medicine), keyword+trigram: Recall@5 ≥ 0.80", r4 >= 0.8, f(r4));
  // A control: keyword alone can't bridge inflection, so the trigram channel is what carries it.
  const r5 = recall("keyword", kind("INFLECTED"));
  report("Control: keyword alone does not find inflected forms (the trigram channel does)", r5 < r3, `${f(r5)} < ${f(r3)}`);

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
