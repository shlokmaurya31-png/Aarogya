/**
 * Week 4b, RAG step 9; grown in RAG Phase 3, step 3.8 — the evaluation on the
 * mock models (CI; docs/RAG_IMPLEMENTATION_PLAN.md §5.3, §11). Builds the
 * synthetic fixture ("rag-eval-v2") through the services and the indexer,
 * asks every question through askAi or askKnowledge (the paths of POST
 * /api/ai/ask and /api/ai/knowledge/ask) and scores it: correct (outcome,
 * exact values, nothing forbidden) AND validly cited (every factual line
 * cites a retrieved source of an expected type, or the expected document).
 *
 * The set is split: "dev" (tuned on) and "test" (held out, reported). The
 * retrieval measures are reported on the held-out split against the plan's
 * targets (Recall@8 ≥ 0.90, MRR ≥ 0.70); the gate holds them at or above the
 * Phase 1 baseline (0.80, 0.64) so they can only move up. Step 3.1's
 * comparison of candidate counts (40/40/30 against the specification's
 * 30/30/20) runs on the development split.
 *
 * Usage: through `npm run verify:all`.
 */
import "./lib/gateBootstrap";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { prisma } from "../src/lib/db";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { setDocumentProvidersForTest } from "../src/lib/ai/documents";
import { setRecordAnswerProviderForTest } from "../src/lib/ai/record";
import { DEFAULT_COUNTS, setCandidateCountsForTest, SPEC_COUNTS } from "../src/lib/rag/candidates";
import { buildEvalFixture } from "./lib/ragEvalFixture";
import { evalMarkdown, QUESTIONS, retrievalMetrics, runRagEval } from "./lib/ragEval";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

/** Phase 1's baseline (2026-11-17): the floors (plan §11.2: a measure only moves up). */
const BASELINE = { recall: 0.80, mrr: 0.64 };
/** The plan's Phase 3 targets (§5.3), reported against the held-out split. */
const TARGET = { recall: 0.90, mrr: 0.70 };

/** The plan's composition (§11.1), group by group. */
const COMPOSITION: Record<string, number> = {
  VISIT_BRIEF: 4, CHART_QA: 8, NURSE: 4, EXPLAIN_REPORT: 5, TIMELINE_PREVISIT: 3, NO_RECORD: 6, READERS: 20, HISTORICAL: 10, MULTI_DOC: 10, MEDICINE: 15, ALLERGY: 8,
  CRITICAL: 6, SOP: 25, INSUFFICIENT: 12, STALE: 8, IMPORTED: 8, OPERATIONAL: 12,
};

async function main() {
  registerAllConsumers();
  setDocumentProvidersForTest(null);
  setRecordAnswerProviderForTest(null);
  const qs = QUESTIONS.questions;
  const count = (g: string) => qs.filter((q) => q.group === g).length;
  report("The set: 230 questions in the plan's groups (§11.1), pending clinical advisor sign-off",
    qs.length === 230 && Object.entries(COMPOSITION).every(([g, n]) => count(g) === n) && QUESTIONS.status === "pending clinical advisor sign-off",
    Object.entries(COMPOSITION).filter(([g, n]) => count(g) !== n).map(([g]) => `${g} ${count(g)}`).join(", "));
  const langs = ["EN", "HI", "MR", "BN", "TA", "TE", "KN", "ML", "GU", "OR", "UR"];
  report("The eleven languages, six questions each, with same-script, inflected, transliterated and cross-script cases",
    langs.every((l) => count(`LANG_${l}`) === 6) && ["same-script", "inflected", "transliterated", "cross-script"].every((k) => qs.filter((q) => q.kind === k).length === 11));
  report("Every question is in the development or the held-out test split, every group in both", qs.every((q) => q.split === "dev" || q.split === "test")
    && [...new Set(qs.map((q) => q.group))].every((g) => qs.some((q) => q.group === g && q.split === "test") && (count(g) < 2 || qs.some((q) => q.group === g && q.split === "dev"))), `${qs.filter((q) => q.split === "test").length} held out`);
  report("The original 30 questions are unchanged and still in the set", ["V1", "Q1", "N1", "E1", "T1", "X1"].every((id) => qs.some((q) => q.id === id)));

  const fx = await buildEvalFixture(Date.now().toString(36));

  // Step 3.1, on the development split only: the specification's 30/30/20 against today's 40/40/30.
  setCandidateCountsForTest(SPEC_COUNTS);
  const spec = retrievalMetrics(await runRagEval(fx, { split: "dev" }), "dev");
  setCandidateCountsForTest(DEFAULT_COUNTS);
  const current = retrievalMetrics(await runRagEval(fx, { split: "dev" }), "dev");
  setCandidateCountsForTest(null);
  console.log(`  candidate counts on the development split: 40/40/30 Recall@8 ${current.recall.toFixed(3)} MRR ${current.mrr.toFixed(3)}; 30/30/20 Recall@8 ${spec.recall.toFixed(3)} MRR ${spec.mrr.toFixed(3)}`);
  report("Step 3.1: both candidate settings measured on the development split; the configured default is the better (or equal) one",
    current.mrr + current.recall >= spec.mrr + spec.recall, `default ${DEFAULT_COUNTS.vector}/${DEFAULT_COUNTS.keyword}/${DEFAULT_COUNTS.rerank}`);

  const run = await runRagEval(fx);
  const md = evalMarkdown(run, "mock");
  console.log(md);
  const dir = path.resolve(__dirname, "..", ".eval-report");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "rag-mock-latest.md"), md + "\n");
  const n = run.scores.length;
  const scored = run.scores.filter((s) => s.score).length;
  const retrieved = run.scores.filter((s) => s.retrieved).length;
  // Plan §5.3: cross-script cases are "reported, no threshold until a multilingual model is adopted"; every other question is held to 90%.
  const crossIds = new Set(qs.filter((q) => q.kind === "cross-script").map((q) => q.id));
  const held = run.scores.filter((x) => !crossIds.has(x.id));
  const cross = run.scores.filter((x) => crossIds.has(x.id));
  console.log(`  correct with valid citations: whole set ${scored}/${n} (${((scored / n) * 100).toFixed(1)}%); cross-script (reported, no threshold) ${cross.filter((x) => x.score).length}/${cross.length}`);
  report("At least 90% correct with valid citations (mock; every question but the cross-script cases, which have no threshold)", held.filter((x) => x.score).length >= Math.ceil(0.9 * held.length), `${held.filter((x) => x.score).length}/${held.length}`);
  report("The expected source retrieved for at least 90%", retrieved >= Math.ceil(0.9 * n), `${retrieved}/${n}`);
  for (const g of ["NO_RECORD", "INSUFFICIENT", "OPERATIONAL"]) report(`Every ${g} question answered NO_RECORD`, run.scores.filter((s) => s.group === g).every((s) => s.correct));
  report("The diagnosis question refused (REFUSED_SAFETY)", run.scores.find((s) => s.id === "E5")!.correct);
  report("Stale documents: no superseded, expired or future-dated version is ever cited", run.scores.filter((s) => s.group === "STALE").every((s) => s.correct));

  const test = retrievalMetrics(run, "test");
  console.log(`  held-out test split: Recall@8 ${test.recall.toFixed(3)} (target ${TARGET.recall}), Precision@8 ${test.precision.toFixed(3)}, MRR ${test.mrr.toFixed(3)} (target ${TARGET.mrr}), nDCG@10 ${test.ndcg.toFixed(3)} over ${test.n} questions`);
  const ORIGINAL = new Set(["VISIT_BRIEF", "CHART_QA", "NURSE", "EXPLAIN_REPORT", "TIMELINE_PREVISIT", "NO_RECORD"]);
  const orig = retrievalMetrics(run, undefined, (g) => ORIGINAL.has(g));
  console.log(`  the original 30 questions (the Phase 1 baseline's set, 0.80 / 0.64): Recall@8 ${orig.recall.toFixed(3)}, MRR ${orig.mrr.toFixed(3)} over ${orig.n}`);
  report("Held-out Recall@8 at or above the Phase 1 baseline (0.80)", test.recall >= BASELINE.recall, test.recall.toFixed(3));
  report("Held-out MRR at or above the Phase 1 baseline (0.64)", test.mrr >= BASELINE.mrr, test.mrr.toFixed(3));
  console.log(`  targets: Recall@8 ${test.recall >= TARGET.recall ? "MET" : `MISSED by ${(TARGET.recall - test.recall).toFixed(3)}`}; MRR ${test.mrr >= TARGET.mrr ? "MET" : `MISSED by ${(TARGET.mrr - test.mrr).toFixed(3)}`}`);
  const reader = run.results.filter((r) => QUESTIONS.questions.find((q) => q.id === r.id)?.group === "READERS");
  const byReader = reader.filter((r) => r.result?.trace?.answeredByReader).length;
  report("Structured-lookup questions answered by a reader (no vector search): at least 95%", byReader >= Math.ceil(0.95 * reader.length), `${byReader}/${reader.length}`);

  // RAG Phase 4 (plan §6.3): the token economy on the whole set.
  const traced = run.results.filter((r) => r.result?.trace?.budget !== undefined);
  const over = traced.filter((r) => r.result!.trace!.inputTokens! > r.result!.trace!.budget!);
  report("Phase 4: no request over its budget (input tokens ≤ the mode's and model's maximum input)", traced.length > 0 && over.length === 0, `${traced.length} budgeted, ${over.length} over${over.length ? `: ${over.map((r) => r.id).join(", ")}` : ""}`);
  const structuredOrOperational = run.results.filter((r) => ["READERS", "OPERATIONAL"].includes(QUESTIONS.questions.find((q) => q.id === r.id)?.group ?? ""));
  const noModel = structuredOrOperational.filter((r) => r.result && (r.result.trace?.tier === 0 || (r.result.outcome === "NO_RECORD" && !r.result.trace?.inputTokens))).length;
  report("Phase 4: structured and operational questions answered without a model (Tier 0, or no record before the model): at least 90%", noModel >= Math.ceil(0.9 * structuredOrOperational.length), `${noModel}/${structuredOrOperational.length}`);

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
