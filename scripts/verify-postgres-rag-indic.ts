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
 * RAG Phase 3 (plan §5.3): production's keyword channel with steps 3.9 and
 * 3.10, separately and together, never lowers a Phase 1 number on this
 * (held-out) set, and the inflected and transliterated cases reach 0.80.
 * Cross-script queries are reported by `npm run eval:rag:indic`, not
 * floored (no multilingual model is adopted). Temporary tables in one
 * transaction: nothing is written.
 *
 * Usage: through `npm run verify:all`.
 */
import { prisma } from "../src/lib/db";
import { summarize } from "../src/lib/rag/metrics";
import { buildCorpus, buildQueries, LANGUAGES, type BenchQuery, type QueryKind } from "../eval/rag/indic/dataset";
import { indicMethods, PHASE3_METHODS } from "./lib/indicBench";

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
      if (name !== "keyword" && name !== "keyword+trigram" && !PHASE3_METHODS.some(([n]) => n === name)) continue;
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

  // RAG Phase 3: steps 3.9 and 3.10, each and together, against every Phase 1 number.
  const KINDS: QueryKind[] = ["SAME_SCRIPT", "INFLECTED", "TRANSLITERATED", "MIXED_SCRIPT", "CROSS_SCRIPT", "MEDICINE_LATIN"];
  for (const [name] of PHASE3_METHODS) {
    const lower = KINDS.filter((k) => recall(name, kind(k)) < recall("keyword+trigram", kind(k)));
    report(`${name}: no Phase 1 number lowered`, lower.length === 0, KINDS.map((k) => `${k} ${f(recall(name, kind(k)))}`).join(", "));
  }
  const both = PHASE3_METHODS[PHASE3_METHODS.length - 1][0];
  report("Steps 3.5 + 3.9 + 3.10 (production): inflected Indic keyword cases ≥ 0.80", recall(both, kind("INFLECTED")) >= 0.8, f(recall(both, kind("INFLECTED"))));
  report("Steps 3.5 + 3.9 + 3.10 (production): transliterated cases ≥ 0.80", recall(both, kind("TRANSLITERATED")) >= 0.8, f(recall(both, kind("TRANSLITERATED"))));
  report("Control: without step 3.9, transliterated queries find nothing (the shadow text is what carries them)", recall(PHASE3_METHODS[0][0], kind("TRANSLITERATED")) === 0);

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
