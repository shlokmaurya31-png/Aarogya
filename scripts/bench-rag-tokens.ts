/**
 * RAG Phase 4 — npm run bench:rag:tokens. The token economy measured on the
 * evaluation set (eval/rag/questions.json, both splits; never the sealed
 * split): the same questions with the economy off (Phase 3: no Tier 0, no
 * compression, no budget fitting, no retrieval cache) and on, against one
 * fixture. Reports per mode: input tokens per answered request (median and
 * mean), output tokens, the share answered at Tier 0, estimated cost per
 * 1,000 queries from the dated price table (UNCONFIRMED list prices), cache
 * hit rates (the knowledge questions asked twice), quality on both splits,
 * and every question whose score changed.
 *
 * Mock providers; usage is the estimate of the exact prompt the configured
 * model would receive (prepare.ts usageOf). Local verify database only;
 * synthetic data only. Writes .eval-report/rag-tokens-latest.md.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_VERIFY_URL = "postgresql://aarogya:aarogya@localhost:5432/aarogya_verify";

async function main() {
  const url = process.env.VERIFY_DATABASE_URL || DEFAULT_VERIFY_URL;
  if (!["localhost", "127.0.0.1", "::1"].includes(new URL(url).hostname)) throw new Error("bench:rag:tokens runs only against a local verify database.");
  process.env.DATABASE_URL = url;
  process.env.DIRECT_URL = url;
  const { prisma } = await import("../src/lib/db");
  const { registerAllConsumers } = await import("../src/lib/runner/consumers");
  const { setDocumentProvidersForTest } = await import("../src/lib/ai/documents");
  const { setRecordAnswerProviderForTest } = await import("../src/lib/ai/record");
  const { setTokenEconomyForTest } = await import("../src/lib/rag/economy");
  const { buildEvalFixture } = await import("./lib/ragEvalFixture");
  const { QUESTIONS, retrievalMetrics, runRagEval } = await import("./lib/ragEval");
  const { DEFAULT_PRICES } = await import("../src/lib/rag/prices");
  registerAllConsumers();
  setDocumentProvidersForTest(null);
  setRecordAnswerProviderForTest(null);
  try {
    const fx = await buildEvalFixture(`tok${Date.now().toString(36)}`);
    type Run = Awaited<ReturnType<typeof runRagEval>>;
    const measure = async (on: boolean): Promise<{ run: Run; rows: Awaited<ReturnType<typeof rowsOf>> }> => {
      setTokenEconomyForTest(on);
      const run = await runRagEval(fx);
      return { run, rows: await rowsOf(run) };
    };
    const rowsOf = async (run: Run) => {
      const ids = run.results.flatMap((r) => (r.result ? [r.result.meta.interactionId] : []));
      return prisma.aiInteraction.findMany({ where: { id: { in: ids } }, select: { id: true, mode: true, outcome: true, tier: true, inputTokens: true, outputTokens: true, embeddingTokens: true, rerankUnits: true, cacheHits: true, estimatedCostMicroUsd: true, retrievalMs: true } });
    };
    const before = await measure(false);
    const after = await measure(true);
    // Cache hit rates: the knowledge questions asked again, with the economy on.
    const knowledge = QUESTIONS.questions.filter((q) => q.mode === "KNOWLEDGE_QA");
    const retrievalHits = async () => (await prisma.aiRetrievalCache.aggregate({ _sum: { hits: true } }))._sum.hits ?? 0;
    const hits0 = await retrievalHits();
    const again = await runRagEval(fx, { questions: knowledge });
    const repeatRetrievalHits = (await retrievalHits()) - hits0;
    const againRows = await rowsOf(again);
    setTokenEconomyForTest(true);

    const modes = [...new Set(QUESTIONS.questions.map((q) => q.mode))];
    const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const answered = <T extends { outcome: string }>(rows: T[]) => rows.filter((r) => r.outcome === "ANSWERED");
    const table = modes.map((m) => {
      const b = answered(before.rows.filter((r) => r.mode === m)), a = answered(after.rows.filter((r) => r.mode === m));
      const bAll = before.rows.filter((r) => r.mode === m), aAll = after.rows.filter((r) => r.mode === m);
      const mb = med(b.map((r) => r.inputTokens)), ma = med(a.map((r) => r.inputTokens));
      const cost = (rows: typeof bAll) => (mean(rows.map((r) => r.estimatedCostMicroUsd)) * 1000) / 1e6;
      return `| ${m} | ${b.length} / ${a.length} | ${mb} → ${ma} (${mb ? (((ma - mb) / mb) * 100).toFixed(0) : "—"}%) | ${mean(b.map((r) => r.inputTokens)).toFixed(0)} → ${mean(a.map((r) => r.inputTokens)).toFixed(0)} | ${mean(b.map((r) => r.outputTokens)).toFixed(0)} → ${mean(a.map((r) => r.outputTokens)).toFixed(0)} | ${a.filter((r) => r.tier === 0).length}/${a.length} | $${cost(bAll).toFixed(2)} → $${cost(aAll).toFixed(2)} |`;
    });
    const quality = (run: Run) => (["test", "dev"] as const).map((sp) => {
      const xs = run.scores.filter((s) => (QUESTIONS.questions.find((q) => q.id === s.id)?.split ?? "dev") === sp);
      const m = retrievalMetrics(run, sp);
      return `${sp}: Recall@8 ${m.recall.toFixed(3)}, MRR ${m.mrr.toFixed(3)}, correct with citations ${xs.filter((s) => s.score).length}/${xs.length}`;
    }).join("; ");
    const changed = before.run.scores.flatMap((b) => { const a = after.run.scores.find((x) => x.id === b.id)!; return a.score !== b.score ? [`| ${b.id} | ${b.score ? "yes" : "no"} → ${a.score ? "yes" : "no"} | ${a.why.join("; ").replace(/\|/g, "/")} |`] : []; });
    const hitRate = (rows: { cacheHits: number }[]) => `${rows.filter((r) => r.cacheHits > 0).length}/${rows.length}`;
    const structuredIds = new Set(QUESTIONS.questions.filter((q) => ["READERS", "OPERATIONAL"].includes(q.group)).map((q) => q.id));
    const tier0 = after.run.results.filter((r) => structuredIds.has(r.id)).map((r) => after.rows.find((x) => x.id === r.result?.meta.interactionId)).filter(Boolean);
    const md = [
      "# Token economy on the evaluation set (RAG Phase 4)", "",
      `- ${QUESTIONS.questions.length} questions, mock providers, usage estimated from the exact prompt the configured model would receive; prices ${DEFAULT_PRICES.asOf}, **${DEFAULT_PRICES.status ?? "unconfirmed"}**.`,
      `- Quality before: ${quality(before.run)}`, `- Quality after: ${quality(after.run)}`,
      `- Structured and operational questions answered without a model (Tier 0, or "no record" before the model): ${tier0.filter((r) => r!.tier === 0).length}/${tier0.length}`,
      `- Knowledge caches, first pass: query embedding from the cache ${hitRate(after.rows.filter((r) => r.mode === "KNOWLEDGE_QA" && r.embeddingTokens === 0 && r.cacheHits > 0))} of ${after.rows.filter((r) => r.mode === "KNOWLEDGE_QA").length} (the evaluation's questions were embedded by earlier runs); retrieval cache ${after.rows.filter((r) => r.mode === "KNOWLEDGE_QA" && r.cacheHits > 0 && r.embeddingTokens > 0).length} (none expected on a first ask)`,
      `- Knowledge caches, the same questions asked again by the same user: retrieval cache hits ${repeatRetrievalHits} of ${againRows.filter((r) => r.outcome !== "NO_RECORD" || r.rerankUnits > 0 || r.cacheHits > 0).length} retrieved requests; requests with any cache hit ${hitRate(againRows)}`,
      `- Patient modes: requests with any cache hit ${after.rows.filter((r) => r.mode !== "KNOWLEDGE_QA" && r.cacheHits > 0).length} of ${after.rows.filter((r) => r.mode !== "KNOWLEDGE_QA").length} (never: no patient-data cache exists)`, "",
      "| Mode | Answered (before / after) | Median input tokens, answered | Mean input | Mean output | Tier 0 (after) | Est. cost per 1,000 queries |", "|---|---|---|---|---|---|---|",
      ...table, "",
      changed.length ? ["| Question | Scored | Why (after) |", "|---|---|---|", ...changed].join("\n") : "No question's score changed.",
    ].join("\n");
    mkdirSync(path.resolve(__dirname, "..", ".eval-report"), { recursive: true });
    writeFileSync(path.resolve(__dirname, "..", ".eval-report", "rag-tokens-latest.md"), md + "\n");
    console.log(md);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(`bench:rag:tokens failed: ${(err as { code?: string }).code ?? (err as Error).message}`);
  process.exit(1);
});
