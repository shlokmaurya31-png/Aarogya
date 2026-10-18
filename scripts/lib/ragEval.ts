/**
 * Week 4b — runs the 30-question RAG evaluation (eval/rag/questions.json)
 * against a fixture built by ragEvalFixture.ts, through askAi (the same path
 * as POST /api/ai/ask), and scores it (src/lib/rag/evalScore.ts). Shared by
 * the CI gate (mocks) and the manual real-provider run.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { prisma } from "../../src/lib/db";
import { askAi, type AskResult } from "../../src/lib/rag/ask";
import { scoreQuestion, type EvalQuestion, type QuestionScore } from "../../src/lib/rag/evalScore";
import { AI_MODES, MODES, type AiMode } from "../../src/lib/rag/modes";
import { modeThreshold } from "../../src/lib/rag/retrieve";
import type { EvalFixture } from "./ragEvalFixture";

export const QUESTIONS: { status: string; questions: EvalQuestion[] } = JSON.parse(readFileSync(path.resolve(__dirname, "..", "..", "eval", "rag", "questions.json"), "utf8"));

export interface EvalRun { scores: QuestionScore[]; results: { id: string; result: AskResult | null; error?: string; latencyMs: number; tokens: number }[]; thresholds: Record<string, number> }

/** The per-minute limit counts the eval's own requests; its clock moves their timestamps back between questions. */
const cool = (userId: string) => prisma.$executeRaw`UPDATE "AiInteraction" SET "createdAt" = "createdAt" - interval '2 minutes', "textExpiresAt" = "textExpiresAt" - interval '2 minutes' WHERE "userId" = ${userId} AND "createdAt" > now() - interval '2 minutes'`;

export async function runRagEval(fx: EvalFixture): Promise<EvalRun> {
  const scores: QuestionScore[] = [];
  const results: EvalRun["results"] = [];
  for (const q of QUESTIONS.questions) {
    const actor = fx.actors[q.actor as keyof EvalFixture["actors"]];
    await cool(actor.userId);
    const started = Date.now();
    try {
      const r = await askAi(actor, {
        mode: q.mode as AiMode, patientId: fx.patientId,
        ...(q.actor === "doctorShare" ? { shareId: fx.shareId } : {}),
        ...(q.ask?.question ? { question: q.ask.question } : {}),
        ...(q.ask?.document ? { documentId: fx.documents[q.ask.document] } : {}),
        ...(q.ask?.language ? { language: q.ask.language } : {}),
        ...(q.ask?.appointment ? { appointmentId: fx.appointments[q.ask.appointment] } : {}),
      });
      const row = await prisma.aiInteraction.findUniqueOrThrow({ where: { id: r.meta.interactionId } });
      const ragIds = row.retrievedChunkIds.filter((id) => !id.startsWith("live:") && !id.startsWith("upload:"));
      const types = (await prisma.ragChunk.findMany({ where: { id: { in: ragIds } }, select: { sourceType: true } })).map((c) => c.sourceType as string)
        .concat(row.retrievedChunkIds.filter((id) => id.startsWith("live:")).map((id) => ({ med: "MEDICATION_ORDER", dose: "MEDICATION_DOSE", allergy: "ALLERGY" }[id.split(":")[1]] ?? "LIVE")))
        .concat(row.retrievedChunkIds.some((id) => id.startsWith("upload:")) ? ["PATIENT_DOCUMENT"] : []);
      scores.push(scoreQuestion(q, r, row, types));
      results.push({ id: q.id, result: r, latencyMs: Date.now() - started, tokens: row.inputTokens + row.outputTokens });
    } catch (err) {
      scores.push({ id: q.id, group: q.group, correct: false, cited: false, retrieved: false, score: false, why: [`error ${(err as { code?: string }).code ?? (err as Error).message}`] });
      results.push({ id: q.id, result: null, error: (err as { code?: string }).code ?? "ERROR", latencyMs: Date.now() - started, tokens: 0 });
    }
  }
  const thresholds = Object.fromEntries(await Promise.all(AI_MODES.map(async (m) => [m, await modeThreshold(m, null, null)])));
  return { scores, results, thresholds };
}

export function evalMarkdown(run: EvalRun, provider: string): string {
  const n = run.scores.length;
  const pct = (k: number) => `${((k / n) * 100).toFixed(1)}%`;
  const scored = run.scores.filter((s) => s.score).length;
  const groups = [...new Set(run.scores.map((s) => s.group))];
  const lat = run.results.map((r) => r.latencyMs).sort((a, b) => a - b);
  return [
    `# RAG evaluation (${provider})`, "",
    `- Questions: ${n} (${QUESTIONS.status})`,
    `- **Correct with valid citations: ${scored}/${n} (${pct(scored)})** (target ≥ 90%)`,
    `- Correct: ${run.scores.filter((s) => s.correct).length}/${n}; cited validly: ${run.scores.filter((s) => s.cited).length}/${n}; expected source retrieved: ${run.scores.filter((s) => s.retrieved).length}/${n}`,
    `- Thresholds in force: ${Object.entries(run.thresholds).map(([m, t]) => `${m} ${t}`).join(", ")}`,
    `- Latency per question: median ${lat[Math.floor(lat.length / 2)]} ms, max ${lat.at(-1)} ms; tokens ${run.results.reduce((a, r) => a + r.tokens, 0)}`, "",
    "| Group | Scored |", "|---|---|", ...groups.map((g) => { const xs = run.scores.filter((s) => s.group === g); return `| ${g} | ${xs.filter((s) => s.score).length}/${xs.length} |`; }), "",
    "| Question | Mode | Outcome | Score | Why not |", "|---|---|---|---|---|",
    ...run.scores.map((s) => { const q = QUESTIONS.questions.find((x) => x.id === s.id)!; const r = run.results.find((x) => x.id === s.id)!; return `| ${s.id} | ${q.mode} | ${r.result?.outcome ?? r.error} | ${s.score ? "yes" : "no"} | ${s.why.join("; ")} |`; }),
  ].join("\n");
}

export { MODES };
