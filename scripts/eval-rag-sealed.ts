/**
 * RAG Phase 4 housekeeping — npm run eval:rag:sealed -- --phase <n> [--split phase5]
 * (docs/RAG_IMPLEMENTATION_PLAN.md §13.5). Runs one sealed held-out split
 * (eval/rag/sealed/<split>.json; phase4 by default) once, at the end of a
 * phase, and reports it beside the old split's figures.
 *
 * The rule, enforced here: the file must match the sha-256 recorded for it in
 * docs/RAG_INDIC_BENCHMARK.md (so it can't be edited after it was sealed),
 * and a (phase, split) already in the ledger (eval/rag/sealed/runs.json,
 * committed) is refused, so no phase runs a split twice. RAG Phase 5: the
 * confidently wrong count (an answer where "no record" or a refusal was right,
 * or an answer with a forbidden value) is reported and recorded on its own. No gate reads the sealed file
 * (scripts/lib/sealedSplit.test.ts), so nothing is tuned against it.
 *
 * Mock providers, the local verify database only, synthetic data only.
 */
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { recordedHashes } from "./lib/sealedHashes";

const ROOT = path.resolve(__dirname, "..");
export const SEALED_SPLITS = ["phase4", "phase5"] as const;
const sealedFile = (split: string) => path.join(ROOT, "eval", "rag", "sealed", `${split}.json`);
const LEDGER = path.join(ROOT, "eval", "rag", "sealed", "runs.json");
const BENCHMARK = path.join(ROOT, "docs", "RAG_INDIC_BENCHMARK.md");
const DEFAULT_VERIFY_URL = "postgresql://aarogya:aarogya@localhost:5432/aarogya_verify";

interface LedgerRun { phase: number; split?: string; commit: string; ranAt: string; sha256: string; questions: number; scored: number; recall8: number; mrr: number; confidentlyWrong?: number }

async function main() {
  const at = process.argv.indexOf("--phase");
  const phase = at > 0 ? Number(process.argv[at + 1]) : NaN;
  if (!Number.isInteger(phase) || phase < 1) throw new Error("Usage: npm run eval:rag:sealed -- --phase <n>");
  const sp = process.argv.indexOf("--split");
  const split = sp > 0 ? process.argv[sp + 1] : "phase4";
  if (!(SEALED_SPLITS as readonly string[]).includes(split)) throw new Error(`--split must be one of ${SEALED_SPLITS.join(", ")}`);
  const bytes = readFileSync(sealedFile(split));
  const sha = createHash("sha256").update(bytes).digest("hex");
  const recorded = recordedHashes(readFileSync(BENCHMARK, "utf8"))[split];
  if (recorded !== sha) { console.error(`Refusing: ${split}.json's sha-256 (${sha}) is not the one recorded in docs/RAG_INDIC_BENCHMARK.md (${recorded ?? "none"}).`); process.exit(2); }
  const ledger: LedgerRun[] = JSON.parse(readFileSync(LEDGER, "utf8"));
  if (ledger.some((r) => r.phase === phase && (r.split ?? "phase4") === split)) { console.error(`Refusing: ${split} has already been run for phase ${phase} (eval/rag/sealed/runs.json). It runs once per phase.`); process.exit(2); }

  const url = process.env.VERIFY_DATABASE_URL || DEFAULT_VERIFY_URL;
  if (!["localhost", "127.0.0.1", "::1"].includes(new URL(url).hostname)) throw new Error("eval:rag:sealed runs only against a local verify database.");
  process.env.DATABASE_URL = url;
  process.env.DIRECT_URL = url;
  const { prisma } = await import("../src/lib/db");
  const { registerAllConsumers } = await import("../src/lib/runner/consumers");
  const { setDocumentProvidersForTest } = await import("../src/lib/ai/documents");
  const { setRecordAnswerProviderForTest } = await import("../src/lib/ai/record");
  const { buildEvalFixture } = await import("./lib/ragEvalFixture");
  const { evalMarkdown, retrievalMetrics, runRagEval } = await import("./lib/ragEval");
  registerAllConsumers();
  setDocumentProvidersForTest(null);
  setRecordAnswerProviderForTest(null);
  try {
    const questions = JSON.parse(bytes.toString("utf8")).questions;
    const fx = await buildEvalFixture(`sealed${Date.now().toString(36)}`);
    const run = await runRagEval(fx, { questions });
    const m = retrievalMetrics(run, "sealed");
    const scored = run.scores.filter((s) => s.score).length;
    const wrong = run.scores.filter((s) => s.confidentlyWrong);
    const commit = execSync("git rev-parse --short HEAD", { cwd: ROOT, encoding: "utf8" }).trim();
    const md = [
      `# Sealed held-out split ${split}, phase ${phase}`, "",
      `- File: eval/rag/sealed/${split}.json, sha-256 \`${sha}\`; commit ${commit}; mock providers; synthetic data.`,
      `- **Retrieval (${m.n} questions): Recall@8 ${m.recall.toFixed(3)}, MRR ${m.mrr.toFixed(3)}, nDCG@10 ${m.ndcg.toFixed(3)}**`,
      `- **Confidently wrong: ${wrong.length}/${run.scores.length}**${wrong.length ? ` (${wrong.map((s) => s.id).join(", ")})` : ""}`, "",
      evalMarkdown(run, "mock, sealed split", questions),
    ].join("\n");
    mkdirSync(path.join(ROOT, ".eval-report"), { recursive: true });
    writeFileSync(path.join(ROOT, ".eval-report", `rag-sealed-${split}-phase${phase}.md`), md + "\n");
    ledger.push({ phase, split, commit, ranAt: new Date().toISOString(), sha256: sha, questions: run.scores.length, scored, recall8: Number(m.recall.toFixed(3)), mrr: Number(m.mrr.toFixed(3)), confidentlyWrong: wrong.length });
    writeFileSync(LEDGER, JSON.stringify(ledger, null, 1) + "\n");
    console.log(md);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(`eval:rag:sealed failed: ${(err as { code?: string }).code ?? (err as Error).message}`);
  process.exit(1);
});
