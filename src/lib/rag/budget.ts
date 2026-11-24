import { resolveEffectiveInternal } from "@/lib/config/resolver";
import { MODES, type AiMode } from "./modes";
import { countTokens, type TokenFamily } from "./tokens";

/**
 * RAG Phase 4, step 4.1 — the token budget (docs/RAG_ARCHITECTURE.md §11.1),
 * set before any provider is called, per mode and per model:
 *
 *   input  = system instructions + output schema   (measured from the prompt)
 *          + question                              ≤ the mode's query cap
 *          + compact context (earlier turns)       ≤ the mode's history cap
 *          + sources                               ≤ the mode's context cap
 *   and input + output allowance + safety margin   ≤ the model's context window
 *
 * The output allowance comes from the mode's word limit. Tokens are counted
 * by the answer provider's family (tokens.ts), never one tokenizer for all.
 * A question or context over its cap is refused, never truncated; a request
 * whose structured facts alone don't fit is refused, not answered from a
 * part of them. Below that, the lowest-ranked passages are dropped to fit.
 */
export interface ModeBudget { query: number; history: number; context: number }

/** Defaults per mode; the context cap can be lowered per organisation or facility (ai.budget.<mode>.context_tokens). */
export const MODE_BUDGETS: Record<AiMode, ModeBudget> = {
  CHART_QA: { query: 250, history: 300, context: 3000 },
  KNOWLEDGE_QA: { query: 250, history: 300, context: 3000 },
  EXPLAIN_REPORT: { query: 250, history: 300, context: 4000 },
  PREVISIT_QUESTIONS: { query: 0, history: 0, context: 3000 },
  VISIT_BRIEF: { query: 0, history: 0, context: 8000 },
  NURSE_HANDOFF: { query: 0, history: 0, context: 8000 },
  HEALTH_TIMELINE: { query: 0, history: 0, context: 8000 },
};

/** Context windows of the answer models (input + output), and the family that counts their tokens. */
export const MODEL_LIMITS: Record<string, { window: number; family: TokenFamily }> = {
  "claude-sonnet-5-5": { window: 1_000_000, family: "anthropic" },
  "claude-haiku-5-5": { window: 1_000_000, family: "anthropic" },
  "claude-opus-5-5": { window: 1_000_000, family: "anthropic" },
  // The offline answerer is budgeted as the smallest window we would deploy, so the mock never hides an overrun.
  "mock-record-1": { window: 200_000, family: "anthropic" },
};
const DEFAULT_LIMIT = { window: 200_000, family: "anthropic" as TokenFamily };
export const limitsFor = (model: string) => MODEL_LIMITS[model] ?? DEFAULT_LIMIT;

/** Output tokens a mode may use: its word limit at the language's tokens per word, plus the answer's structure (citations, kinds). */
export function outputAllowance(mode: AiMode, language: string): number {
  const perWord = language === "en" ? 1.4 : 4;
  return Math.ceil(MODES[mode].maxWords * perWord) + 256;
}

export const SAFETY_MARGIN = 512;

export interface Budget {
  mode: AiMode; model: string; family: TokenFamily;
  system: number; query: number; history: number; output: number;
  /** Tokens available for sources: the mode's cap, or less if the window is the limit. */
  context: number;
  /** The most input this request may send (system + query + history + context caps). */
  maxInput: number;
}

export class BudgetError extends Error {
  constructor(readonly code: "QUESTION_TOO_LONG" | "CONTEXT_TOO_LONG" | "STRUCTURED_FACTS_DO_NOT_FIT") {
    super(code);
    this.name = "BudgetError";
  }
}

let overrides: Partial<Record<AiMode, Partial<ModeBudget>>> = {};
/** Gates only: shrink a mode's caps (the refusal when structured facts don't fit). */
export function setModeBudgetForTest(mode: AiMode, b: Partial<ModeBudget> | null) {
  overrides = { ...overrides, [mode]: b ?? undefined };
}

async function contextCap(mode: AiMode, organizationId: string | null, facilityId: string | null): Promise<number> {
  const base = overrides[mode]?.context ?? MODE_BUDGETS[mode].context;
  if (!organizationId) return base;
  const eff = await resolveEffectiveInternal({ key: `ai.budget.${mode.toLowerCase()}.context_tokens`, organizationId, facilityId: facilityId ?? undefined, fallbackRaw: String(base) });
  return typeof eff.value === "number" ? Math.min(base, eff.value) : base;
}

/**
 * The budget for one request, before the provider is called. Refuses a
 * question or compact context over its cap.
 */
export async function planBudget(input: {
  mode: AiMode; model: string; language: string; system: string; question?: string | null; history?: string | null;
  organizationId: string | null; facilityId: string | null;
}): Promise<Budget> {
  const { family, window } = limitsFor(input.model);
  const caps = { ...MODE_BUDGETS[input.mode], ...overrides[input.mode] };
  const system = countTokens(input.system, family);
  const query = input.question ? countTokens(input.question, family) : 0;
  const history = input.history ? countTokens(input.history, family) : 0;
  if (query > caps.query && input.question) throw new BudgetError("QUESTION_TOO_LONG");
  if (history > caps.history && input.history) throw new BudgetError("CONTEXT_TOO_LONG");
  const output = outputAllowance(input.mode, input.language);
  const cap = await contextCap(input.mode, input.organizationId, input.facilityId);
  const context = Math.max(0, Math.min(cap, window - output - SAFETY_MARGIN - system - caps.query - caps.history));
  return { mode: input.mode, model: input.model, family, system, query, history, output, context, maxInput: system + caps.query + caps.history + context };
}

export interface Budgeted { text: string; context: string; translation?: { text: string } | undefined }

/** The tokens one source takes in the prompt, as buildRecordPrompt lays it out. */
export function sourceTokens(s: Budgeted & { n: number }, family: TokenFamily): number {
  return countTokens(`[${s.n}] ${s.context}\n${s.text}${s.translation ? `\n(translation, values as in the original): ${s.translation.text}` : ""}\n\n`, family);
}

/**
 * Fits the sources into the budget's context: every structured fact (or the
 * request is refused), then the rest in rank order while they fit. Returns
 * the kept sources in their original order and the tokens they take.
 */
export function fitSources<T extends Budgeted & { n: number }>(sources: T[], isStructured: (s: T) => boolean, budget: Pick<Budget, "context" | "family">): { kept: T[]; used: number; dropped: number } {
  let used = 0;
  const keep = new Set<T>();
  for (const s of sources.filter(isStructured)) { used += sourceTokens(s, budget.family); keep.add(s); }
  if (used > budget.context) throw new BudgetError("STRUCTURED_FACTS_DO_NOT_FIT");
  for (const s of sources) {
    if (keep.has(s)) continue;
    const t = sourceTokens(s, budget.family);
    if (used + t <= budget.context) { used += t; keep.add(s); }
  }
  const kept = sources.filter((s) => keep.has(s));
  return { kept, used, dropped: sources.length - kept.length };
}
