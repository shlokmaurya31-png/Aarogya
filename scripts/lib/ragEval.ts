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
import { askKnowledge } from "../../src/lib/rag/knowledgeAsk";
import { KNOWLEDGE_DOCS } from "../../eval/rag/knowledgeDocs";
import { scoreQuestion, type EvalQuestion, type QuestionScore } from "../../src/lib/rag/evalScore";
import { AI_MODES, MODES, type AiMode } from "../../src/lib/rag/modes";
import { modeThreshold } from "../../src/lib/rag/retrieve";
import type { EvalFixture } from "./ragEvalFixture";
import { summarize } from "../../src/lib/rag/metrics";

export const QUESTIONS: { status: string; questions: EvalQuestion[] } = JSON.parse(readFileSync(path.resolve(__dirname, "..", "..", "eval", "rag", "questions.json"), "utf8"));

/**
 * RAG Phase 1, step 1.8: what each answered question retrieved, in rank order (source types), and which types it expected.
 * RAG Phase 3: a knowledge source is its document ("KD:<key>"), so the right document is what counts; a question that was
 * expected to be answered but wasn't is still ranked, by what retrieval found (its candidates, in order), so the measure is
 * retrieval's, not the "no record" threshold's.
 */
export interface RankedRetrieval { id: string; split: "dev" | "test"; group: string; types: string[]; expected: string[] }
export interface EvalRun { scores: QuestionScore[]; results: { id: string; result: AskResult | null; error?: string; latencyMs: number; tokens: number; retrievalMs?: number | null }[]; thresholds: Record<string, number>; ranked: RankedRetrieval[] }

/** Recall@8, Precision@8, MRR and nDCG@10 by expected source type (or document), over the questions expected to be answered that name one; one split, or both. */
export function retrievalMetrics(run: EvalRun, split?: "dev" | "test", group?: (g: string) => boolean) {
  const js = run.ranked.filter((r) => (!split || r.split === split) && (!group || group(r.group))).map((r) => ({ ranked: r.types, relevant: (t: string) => r.expected.includes(t) }));
  return summarize(js, 8, 10);
}

/** The per-minute and per-day limits (and the facility's daily budget) count the eval's own requests; its clock moves their timestamps back past both windows between questions (230 questions, some asked twice, exceed a day's 400). */
const cool = (userId: string) => prisma.$executeRaw`UPDATE "AiInteraction" SET "createdAt" = "createdAt" - interval '25 hours', "textExpiresAt" = "textExpiresAt" - interval '25 hours' WHERE "userId" = ${userId} AND "createdAt" > now() - interval '25 hours'`;

export async function runRagEval(fx: EvalFixture, opts: { split?: "dev" | "test" } = {}): Promise<EvalRun> {
  const scores: QuestionScore[] = [];
  const results: EvalRun["results"] = [];
  const ranked: RankedRetrieval[] = [];
  // A knowledge document is known by its title (the fixture's titles end with a run tag), so a copy an earlier run left in
  // the same local database is the same document; on a fresh database (CI) there is one of each.
  const titled = await prisma.knowledgeDocument.findMany({ where: { OR: KNOWLEDGE_DOCS.map((d) => ({ title: { startsWith: `${d.title} ` } })) }, select: { id: true, title: true } });
  const docKey = (title: string) => KNOWLEDGE_DOCS.filter((d) => title.startsWith(`${d.title} `)).sort((a, b) => b.title.length - a.title.length)[0]?.key;
  const keyOf = new Map(titled.flatMap((d) => { const k = docKey(d.title); return k ? [[d.id, k] as const] : []; }));
  const idsOf: Record<string, string[]> = {};
  for (const [id, k] of keyOf) (idsOf[k] ??= []).push(id);
  for (const q of QUESTIONS.questions.filter((x) => !opts.split || (x.split ?? "dev") === opts.split)) {
    const actor = fx.actors[q.actor as keyof EvalFixture["actors"]];
    await cool(actor.userId);
    const started = Date.now();
    try {
      const r = q.mode === "KNOWLEDGE_QA" && actor.kind === "STAFF" ? await askKnowledge(actor, { question: q.ask?.question ?? "", ...(q.ask?.language ? { language: q.ask.language } : {}) }) : await askAi(actor, {
        mode: q.mode as AiMode, patientId: fx.patients[q.patient ?? "main"] ?? fx.patientId,
        ...(q.actor === "doctorShare" ? { shareId: fx.shareId } : {}),
        ...(q.ask?.question ? { question: q.ask.question } : {}),
        ...(q.ask?.document ? { documentId: fx.documents[q.ask.document] } : {}),
        ...(q.ask?.language ? { language: q.ask.language } : {}),
        ...(q.ask?.appointment ? { appointmentId: fx.appointments[q.ask.appointment] } : {}),
      });
      const row = await prisma.aiInteraction.findUniqueOrThrow({ where: { id: r.meta.interactionId } });
      // In rank order (the order the sources were given to the model), as the interaction recorded them: index
      // passages, live facts and (RAG Phase 3) structured readers' facts alike.
      const item = (sourceType: string, sourceId: string) => (sourceType === "KNOWLEDGE_DOCUMENT" ? `KD:${keyOf.get(sourceId) ?? "other"}` : sourceType);
      let types = (await prisma.aiInteractionSource.findMany({ where: { interactionId: r.meta.interactionId }, orderBy: { rank: "asc" }, select: { sourceType: true, sourceId: true } })).map((x) => item(x.sourceType, x.sourceId));
      if (!types.length && row.retrievedChunkIds.length) {
        // Not answered: what retrieval found, in its order.
        const chunks = new Map((await prisma.ragChunk.findMany({ where: { id: { in: row.retrievedChunkIds } }, select: { id: true, sourceType: true, sourceId: true } })).map((c) => [c.id, c]));
        types = row.retrievedChunkIds.flatMap((id) => { const c = chunks.get(id); return c ? [item(c.sourceType, c.sourceId)] : []; });
      }
      const expected = q.expect.documents?.length ? q.expect.documents.map((k) => `KD:${k}`) : q.expect.sources ?? [];
      if (q.expect.outcome === "ANSWERED" && expected.length) ranked.push({ id: q.id, split: q.split ?? "dev", group: q.group, types, expected });
      scores.push(scoreQuestion(q, r, row, types, idsOf));
      results.push({ id: q.id, result: r, latencyMs: Date.now() - started, tokens: row.inputTokens + row.outputTokens, retrievalMs: row.retrievalMs });
    } catch (err) {
      scores.push({ id: q.id, group: q.group, correct: false, cited: false, retrieved: false, score: false, why: [`error ${(err as { code?: string }).code ?? (err as Error).message}`] });
      results.push({ id: q.id, result: null, error: (err as { code?: string }).code ?? "ERROR", latencyMs: Date.now() - started, tokens: 0 });
    }
  }
  const thresholds = Object.fromEntries(await Promise.all(AI_MODES.map(async (m) => [m, await modeThreshold(m, null, null)])));
  return { scores, results, thresholds, ranked };
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
    ...(["test", "dev", undefined] as const).map((sp) => { const m = retrievalMetrics(run, sp); return `- Retrieval, ${sp === "test" ? "**held-out test split**" : sp === "dev" ? "development split" : "whole set"} (by expected source type or document, ${m.n} questions): Recall@8 ${m.recall.toFixed(2)}, Precision@8 ${m.precision.toFixed(2)}, MRR ${m.mrr.toFixed(2)}, nDCG@10 ${m.ndcg.toFixed(2)}`; }),
    ...(["test", "dev"] as const).map((sp) => { const xs = run.scores.filter((s) => (QUESTIONS.questions.find((q) => q.id === s.id)?.split ?? "dev") === sp); return `- Correct with valid citations, ${sp} split: ${xs.filter((s) => s.score).length}/${xs.length} (${((xs.filter((s) => s.score).length / Math.max(1, xs.length)) * 100).toFixed(1)}%); expected source retrieved ${xs.filter((s) => s.retrieved).length}/${xs.length}`; }),
    `- Latency per question: median ${lat[Math.floor(lat.length / 2)]} ms, max ${lat.at(-1)} ms; tokens ${run.results.reduce((a, r) => a + r.tokens, 0)}`, "",
    "| Group | Scored | Scored (test) | Recall@8 / MRR (test) |", "|---|---|---|---|", ...groups.map((g) => {
      const xs = run.scores.filter((s) => s.group === g);
      const ts = xs.filter((s) => QUESTIONS.questions.find((q) => q.id === s.id)?.split === "test");
      const m = retrievalMetrics(run, "test", (x) => x === g);
      return `| ${g} | ${xs.filter((s) => s.score).length}/${xs.length} | ${ts.filter((s) => s.score).length}/${ts.length} | ${m.n ? `${m.recall.toFixed(2)} / ${m.mrr.toFixed(2)}` : "—"} |`;
    }), "",
    "| Question | Split | Mode | Route | Outcome | Score | Why not |", "|---|---|---|---|---|---|---|",
    ...run.scores.map((s) => { const q = QUESTIONS.questions.find((x) => x.id === s.id)!; const r = run.results.find((x) => x.id === s.id)!; const t = r.result?.trace; return `| ${s.id} | ${q.split ?? "dev"} | ${q.mode} | ${t ? `${t.intent}${t.answeredByReader ? " (reader)" : ""}` : "—"} | ${r.result?.outcome ?? r.error} | ${s.score ? "yes" : "no"} | ${s.why.join("; ").replace(/\|/g, "/")} |`; }),
  ].join("\n");
}

export { MODES };
