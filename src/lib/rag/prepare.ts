import { aiModel } from "@/lib/ai/models";
import { ANSWER_TOOL, buildRecordPrompt } from "@/lib/ai/record/claude";
import type { AnswerRequest, AnswerSentence, RecordSource } from "@/lib/ai/record/types";
import { fitSources, planBudget, type Budget } from "./budget";
import { compressSources } from "./compress";
import { tokenEconomy } from "./economy";
import { MODES, type AiMode } from "./modes";
import { compressPassage, semanticCompressionAllowed } from "./semanticCompress";
import { countTokens } from "./tokens";

/**
 * RAG Phase 4 — what both answer pipelines (ask.ts, knowledgeAsk.ts) do to
 * the sources between retrieval and the provider:
 *   1. the budget for this mode and model (budget.ts), before the call;
 *   2. level 1 compression on the provider's copy (compress.ts);
 *   3. structured facts first, then passages by rank, while they fit; a
 *      passage that doesn't fit is compressed at level 2 where allowed
 *      (semanticCompress.ts), else dropped.
 * The originals are returned too: the validator checks the answer against
 * them, never against a compressed copy.
 */
export interface Prepared {
  provided: RecordSource[];
  /** The masked originals by number, for validation. */
  originals: Map<number, RecordSource>;
  budget: Budget;
  dropped: number;
  /** The model the budget and the price are for (the configured one, even while the mock answers). */
  model: string;
}

export function systemPromptFor(req: Pick<AnswerRequest, "mode" | "language" | "conversation">): string {
  return `${buildRecordPrompt({ ...req, audience: MODES[req.mode].audience, sources: [] }).system}\n${JSON.stringify(ANSWER_TOOL)}`;
}

export async function prepareSources(input: {
  mode: AiMode; language: string; question?: string | null; conversation?: string | null; providerId: string;
  organizationId: string | null; facilityId: string | null;
  sources: (RecordSource & { documentId?: string; structured?: boolean })[];
}): Promise<Prepared> {
  const model = aiModel(MODES[input.mode].model);
  const budgetModel = input.providerId === "mock" ? "mock-record-1" : model;
  const budget = await planBudget({
    mode: input.mode, model: budgetModel, language: input.language, system: systemPromptFor({ mode: input.mode, language: input.language, conversation: input.conversation ?? undefined }),
    question: input.question, history: input.conversation, organizationId: input.organizationId, facilityId: input.facilityId,
  });
  const originals = new Map(input.sources.map((s) => [s.n, strip(s)]));
  if (!tokenEconomy()) return { provided: input.sources.map(strip), originals, budget, dropped: 0, model };
  const compressed = compressSources(input.sources);
  let fit = fitSources(compressed, (s) => !!s.structured, budget);
  if (fit.dropped && (await semanticCompressionAllowed(input.organizationId))) {
    const kept = new Set(fit.kept.map((s) => s.n));
    const shortened = await Promise.all(compressed.map(async (s) => (kept.has(s.n) || s.structured ? s : { ...s, text: (await compressPassage(s.text)) ?? s.text })));
    fit = fitSources(shortened, (s) => !!s.structured, budget);
  }
  return { provided: fit.kept.map(strip), originals, budget, dropped: fit.dropped, model };
}

function strip(s: RecordSource & { documentId?: string; structured?: boolean }): RecordSource {
  return { n: s.n, chunkId: s.chunkId, context: s.context, text: s.text, ...(s.translation ? { translation: s.translation } : {}) };
}

/**
 * What a request sent and received, in the answer provider's tokens: the
 * provider's own report where it gave one, else (the offline answerer) the
 * estimate of the exact prompt and answer it stands in for.
 */
export function usageOf(req: AnswerRequest, answer: { inputTokens: number; outputTokens: number; outcome: string; sentences: AnswerSentence[] }): { inputTokens: number; outputTokens: number } {
  if (answer.inputTokens > 0) return { inputTokens: answer.inputTokens, outputTokens: answer.outputTokens };
  const { system, user } = buildRecordPrompt(req);
  return {
    inputTokens: countTokens(`${system}\n${JSON.stringify(ANSWER_TOOL)}`, "anthropic") + countTokens(user, "anthropic"),
    outputTokens: countTokens(JSON.stringify({ outcome: answer.outcome, sentences: answer.sentences }), "anthropic"),
  };
}
