/**
 * RAG Phase 4 housekeeping — npm run eval:rag:sealed -- --phase <n>
 * (docs/RAG_IMPLEMENTATION_PLAN.md §13.5). Runs the sealed held-out split
 * (eval/rag/sealed/phase4.json) once, at the end of a phase, and reports it
 * beside the old split's figures.
 *
 * The rule, enforced here: the file must match the sha-256 recorded in
 * docs/RAG_INDIC_BENCHMARK.md (so it can't be edited after it was sealed),
 * and a phase already in the ledger (eval/rag/sealed/runs.json, committed)
 * is refused, so no phase runs it twice. No gate reads the sealed file
 * (scripts/lib/sealedSplit.test.ts), so nothing is tuned against it.
 *
 * Mock providers, the local verify database only, synthetic data only.
 */
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
export const SEALED_FILE = path.join(ROOT, "eval", "rag", "sealed", "phase4.json");
const LEDGER = path.join(ROOT, "eval", "rag", "sealed", "runs.json");
const BENCHMARK = path.join(ROOT, "docs", "RAG_INDIC_BENCHMARK.md");
const DEFAULT_VERIFY_URL = "postgresql://aarogya:aarogya@localhost:5432/aarogya_verify";

interface LedgerRun { phase: number; commit: string; ranAt: string; sha256: string; questions: number; scored: number; recall8: number; mrr: number }

async function main() {
  const at = process.argv.indexOf("--phase");
  const phase = at > 0 ? Number(process.argv[at + 1]) : NaN;
  if (!Number.isInteger(phase) || phase < 1) throw new Error("Usage: npm run eval:rag:sealed -- --phase <n>");
  const bytes = readFileSync(SEALED_FILE);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const recorded = /sealed split sha-256: `([0-9a-f]{64})`/.exec(readFileSync(BENCHMARK, "utf8"))?.[1];
  if (recorded !== sha) { console.error(`Refusing: the sealed file's sha-256 (${sha}) is not the one recorded in docs/RAG_INDIC_BENCHMARK.md (${recorded ?? "none"}).`); process.exit(2); }
  const ledger: LedgerRun[] = JSON.parse(readFileSync(LEDGER, "utf8"));
  if (ledger.some((r) => r.phase === phase)) { console.error(`Refusing: the sealed split has already been run for phase ${phase} (eval/rag/sealed/runs.json). It runs once per phase.`); process.exit(2); }

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
    const commit = execSync("git rev-parse --short HEAD", { cwd: ROOT, encoding: "utf8" }).trim();
    const md = [
      `# Sealed held-out split, phase ${phase}`, "",
      `- File: eval/rag/sealed/phase4.json, sha-256 \`${sha}\`; commit ${commit}; mock providers; synthetic data.`,
      `- **Retrieval (${m.n} questions): Recall@8 ${m.recall.toFixed(3)}, MRR ${m.mrr.toFixed(3)}, nDCG@10 ${m.ndcg.toFixed(3)}**`, "",
      evalMarkdown(run, "mock, sealed split", questions),
    ].join("\n");
    mkdirSync(path.join(ROOT, ".eval-report"), { recursive: true });
    writeFileSync(path.join(ROOT, ".eval-report", `rag-sealed-phase${phase}.md`), md + "\n");
    ledger.push({ phase, commit, ranAt: new Date().toISOString(), sha256: sha, questions: run.scores.length, scored, recall8: Number(m.recall.toFixed(3)), mrr: Number(m.mrr.toFixed(3)) });
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
