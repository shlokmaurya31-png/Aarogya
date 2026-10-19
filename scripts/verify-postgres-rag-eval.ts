/**
 * Week 4b, RAG step 9 — the 30-question evaluation on the mock models (CI;
 * docs/RAG_DESIGN.md §10). Builds the synthetic fixture through the services
 * and the indexer, asks every question through askAi (the path of POST
 * /api/ai/ask) and scores it: correct (outcome, exact values, nothing
 * forbidden) AND validly cited (every factual line cites a retrieved source of
 * an expected type, with the expected labels). Targets: at least 90% scored,
 * and the expected source retrieved for at least 90% (the plumbing check the
 * mocks can make; model quality is the manual real run, npm run eval:rag:real).
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-rag-eval.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { prisma } from "../src/lib/db";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { setDocumentProvidersForTest } from "../src/lib/ai/documents";
import { setRecordAnswerProviderForTest } from "../src/lib/ai/record";
import { buildEvalFixture } from "./lib/ragEvalFixture";
import { evalMarkdown, QUESTIONS, runRagEval } from "./lib/ragEval";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

async function main() {
  registerAllConsumers();
  setDocumentProvidersForTest(null);
  setRecordAnswerProviderForTest(null);
  const qs = QUESTIONS.questions;
  const count = (g: string) => qs.filter((q) => q.group === g).length;
  report("The set: 30 questions as the design lays out (4 brief, 8 chart Q&A, 4 nurse, 5 explain, 3 timeline/pre-visit, 6 not in the record), pending clinical advisor sign-off",
    qs.length === 30 && [count("VISIT_BRIEF"), count("CHART_QA"), count("NURSE"), count("EXPLAIN_REPORT"), count("TIMELINE_PREVISIT"), count("NO_RECORD")].join() === "4,8,4,5,3,6"
      && QUESTIONS.status === "pending clinical advisor sign-off" && qs.filter((q) => q.group === "NO_RECORD" && q.actor === "patient").length === 3
      && qs.filter((q) => q.group === "EXPLAIN_REPORT" && ["hi", "mr"].includes(q.ask?.language ?? "")).length === 2);

  const fx = await buildEvalFixture(Date.now().toString(36));
  const run = await runRagEval(fx);
  const md = evalMarkdown(run, "mock");
  console.log(md);
  const dir = path.resolve(__dirname, "..", ".eval-report");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "rag-mock-latest.md"), md + "\n");
  const scored = run.scores.filter((s) => s.score).length;
  const retrieved = run.scores.filter((s) => s.retrieved).length;
  report("At least 90% correct with valid citations (mock)", scored >= 27, `${scored}/30`);
  report("The expected source retrieved for at least 90%", retrieved >= 27, `${retrieved}/30`);
  report("Every not-in-the-record question answered NO_RECORD (three in patient modes)", run.scores.filter((s) => s.group === "NO_RECORD").every((s) => s.correct));
  report("The diagnosis question refused (REFUSED_SAFETY)", run.scores.find((s) => s.id === "E5")!.correct);

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
