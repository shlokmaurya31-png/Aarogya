import type { AiPermit } from "@/lib/ai/record/types";
import { assertAiPermit } from "@/lib/ai/record/permit";
import type { RetrievalPlan, RouteMode, RouteResult } from "./router";

/**
 * RAG Phase 3, step 3.2 — choosing between the router's candidates when the
 * rules found two families the mode can't both serve (src/lib/rag/router.ts,
 * AMBIGUOUS). A model is asked only then, on the cheapest tier, and it may
 * only pick one of the candidates it is given: it cannot add a reader, a
 * scope or a mode. Its answer is a candidate index, never text.
 *
 * Only the deterministic mock exists in this phase (no provider key and no
 * budget, plan §13 decision 12). The mock prefers what the mode can serve
 * (a patient reader in a record mode; knowledge in knowledge Q&A), then the
 * candidate whose rules matched more of the question; a tie is MIXED when both
 * are patient channels, else the first.
 */
export interface IntentClassifier {
  id: string;
  choose(input: { question: string; mode: RouteMode; candidates: RetrievalPlan[] }, permit: AiPermit): Promise<number>;
}

const servable = (mode: RouteMode, p: RetrievalPlan) => (mode === "KNOWLEDGE_QA" ? p.intent === "KNOWLEDGE" : p.intent === "STRUCTURED_LOOKUP" || p.intent === "MIXED" || p.intent === "NARRATIVE");

export const mockIntentClassifier: IntentClassifier = {
  id: "mock-intent-1",
  async choose({ mode, candidates }, permit) {
    assertAiPermit(permit);
    if (permit.real) throw new Error("The mock intent classifier never sees real data.");
    const ranked = candidates.map((c, i) => ({ i, s: (servable(mode, c) ? 10 : 0) + c.readers.length })).sort((a, b) => b.s - a.s || a.i - b.i);
    return ranked[0].i;
  },
};

let classifier: IntentClassifier = mockIntentClassifier;
export function setIntentClassifierForTest(c: IntentClassifier | null) { classifier = c ?? mockIntentClassifier; }

/** The router's plan, with an ambiguous result settled by the classifier (confidence MODEL). */
export async function settle(result: RouteResult, input: { question: string; mode: RouteMode }, permit: AiPermit): Promise<RetrievalPlan & { classifier?: string }> {
  if (result.kind === "PLAN") return result.plan;
  const i = await classifier.choose({ ...input, candidates: result.candidates }, permit);
  const chosen = result.candidates[i];
  // Only a candidate the rules produced; anything else falls back to the safe default (the first, never widened).
  if (!chosen) return { ...result.candidates[0], confidence: "MODEL", classifier: classifier.id };
  return { ...chosen, confidence: "MODEL", classifier: classifier.id };
}
