/**
 * Week 4b — npm run eval:rag [-- --provider real]   (npm run eval:rag:real)
 * (docs/RAG_DESIGN.md §10.2). Builds the synthetic evaluation patient and asks
 * the 30 questions through askAi, scoring correct-with-valid-citations.
 *
 * Runs against the LOCAL verify database only (VERIFY_DATABASE_URL, default
 * aarogya_verify on localhost; migrated and seeded by npm run verify:all),
 * never the dev database: it adds synthetic fixtures. Never in CI as the real
 * run; the mock run is also the CI gate (verify-postgres-rag-eval).
 *
 * --provider real (MANUAL): Claude answers (RECORD model per mode), and
 * Voyage embeddings and rerank if VOYAGE_API_KEY is set (a re-embed into a
 * Voyage space, switched to for the run), otherwise the offline embeddings.
 * Synthetic data only; refuses while AI_REAL_DATA_ENABLED=true; keys read
 * from the environment or .env.local and never printed; a content-free
 * preflight first, so a refused account sends nothing else (exit 3).
 * Writes .eval-report/rag-<provider>-<time>.md.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readLocalKeys } from "./lib/localKeys";
import { anthropicPreflight } from "./lib/providerPreflight";

const DEFAULT_VERIFY_URL = "postgresql://aarogya:aarogya@localhost:5432/aarogya_verify";
const REPORTS = path.resolve(__dirname, "..", ".eval-report");

async function main() {
  const real = process.argv.includes("--provider") && process.argv[process.argv.indexOf("--provider") + 1] === "real";
  const url = process.env.VERIFY_DATABASE_URL || DEFAULT_VERIFY_URL;
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error("eval:rag runs only against a local verify database.");
  // Point Prisma at the verify database before anything imports it.
  process.env.DATABASE_URL = url;
  process.env.DIRECT_URL = url;
  mkdirSync(REPORTS, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const keys = readLocalKeys(["ANTHROPIC_API_KEY", "VOYAGE_API_KEY", "AI_REAL_DATA_ENABLED"] as const);
  const { aiModel } = await import("../src/lib/ai/models");

  if (real) {
    if (keys.AI_REAL_DATA_ENABLED === "true") { console.error("Refusing: AI_REAL_DATA_ENABLED=true. The real-data switch must stay off; this run is for synthetic data only."); process.exit(2); }
    if (!keys.ANTHROPIC_API_KEY) { console.log("Ready, not run: no ANTHROPIC_API_KEY in the environment or .env.local. Nothing was sent anywhere."); return; }
    const pre = await anthropicPreflight(keys.ANTHROPIC_API_KEY, aiModel("chart_qa"));
    if (pre !== "OK") {
      const note = `Ready, not run: the key is set but the provider refused the account (${pre}). No question was sent.`;
      console.log(note);
      writeFileSync(path.join(REPORTS, "rag-real-latest.md"), `# RAG evaluation (claude)\n\n- ${new Date().toISOString()}: ${note}\n`);
      process.exit(3);
    }
  }

  const { prisma } = await import("../src/lib/db");
  const { registerAllConsumers } = await import("../src/lib/runner/consumers");
  const { setDocumentProvidersForTest } = await import("../src/lib/ai/documents");
  const { setRecordAnswerProviderForTest } = await import("../src/lib/ai/record");
  const { claudeRecordAnswer } = await import("../src/lib/ai/record/claude");
  const { buildEvalFixture } = await import("./lib/ragEvalFixture");
  const { evalMarkdown, runRagEval } = await import("./lib/ragEval");
  registerAllConsumers();
  setDocumentProvidersForTest(null);
  setRecordAnswerProviderForTest(real ? claudeRecordAnswer(keys.ANTHROPIC_API_KEY!) : null);
  try {
    const fx = await buildEvalFixture(`${real ? "real" : "mock"}${Date.now().toString(36)}`);
    let embeddings = "offline (mock-hash)";
    if (real && keys.VOYAGE_API_KEY) {
      process.env.VOYAGE_API_KEY = keys.VOYAGE_API_KEY;
      const { activateEmbeddingSpace, reembedBatch, startReembed } = await import("../src/lib/rag/reembed");
      const space = await startReembed({ embeddingModel: "voyage-multilingual-2", embeddingVersion: 1, provider: "voyage", dims: 1024 });
      while ((await reembedBatch({ spaceId: space.id, batchSize: 64 })).remaining > 0) { /* converge */ }
      await activateEmbeddingSpace({ spaceId: space.id, byUserId: "eval-rag-real" });
      embeddings = "voyage-multilingual-2 + rerank-2";
    }
    const run = await runRagEval(fx);
    const md = `${evalMarkdown(run, real ? "claude" : "mock")}\n\n- Embeddings: ${embeddings}; answers: ${real ? `Claude (${(["visit_brief", "chart_qa", "nurse_handoff", "explain_report", "health_timeline", "previsit_questions"] as const).map((k) => `${k} ${aiModel(k)}`).join(", ")})` : "the offline mock"}\n- Data: synthetic only; the real-data switch was off.`;
    writeFileSync(path.join(REPORTS, `rag-${real ? "real" : "mock"}-${stamp}.md`), md + "\n");
    writeFileSync(path.join(REPORTS, `rag-${real ? "real" : "mock"}-latest.md`), md + "\n");
    console.log(md);
    const scored = run.scores.filter((s) => s.score).length;
    if (scored < 27) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(`eval:rag failed: ${(err as { code?: string }).code ?? (err as Error).message}`);
  process.exit(1);
});
