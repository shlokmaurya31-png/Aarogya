import type { AiModelKey } from "@/lib/ai/models";

/**
 * Week 4b — the AI modes over one patient's record (docs/RAG_DESIGN.md §1).
 * Who may use each, what it needs, how much retrieval keeps, and which
 * "no record found" threshold applies (§7.3). Pending clinical advisor: each
 * mode's prompt and refusal rules (§9.9).
 */
export const AI_MODES = ["VISIT_BRIEF", "CHART_QA", "NURSE_HANDOFF", "EXPLAIN_REPORT", "HEALTH_TIMELINE", "PREVISIT_QUESTIONS"] as const;
export type AiMode = (typeof AI_MODES)[number];

export type AiAudience = "STAFF" | "PATIENT";

export interface ModeSpec {
  /** Staff modes stream sentence by sentence; patient modes are buffered whole (§8.2). */
  audience: AiAudience;
  /** Chunks kept after reranking (§7.2). */
  keep: number;
  /** Always add the latest vitals day, the allergy and problem lists, and the live medications (§7.2). */
  context: boolean;
  model: AiModelKey;
  threshold: `ai.threshold.${string}`;
  /** Default threshold in thousandths (the config registry's default). */
  defaultThreshold: number;
  /** Words at most (CHART_QA: 150). */
  maxWords: number;
}

export const MODES: Record<AiMode, ModeSpec> = {
  VISIT_BRIEF: { audience: "STAFF", keep: 12, context: true, model: "visit_brief", threshold: "ai.threshold.visit_brief", defaultThreshold: 300, maxWords: 450 },
  CHART_QA: { audience: "STAFF", keep: 8, context: false, model: "chart_qa", threshold: "ai.threshold.chart_qa", defaultThreshold: 300, maxWords: 150 },
  NURSE_HANDOFF: { audience: "STAFF", keep: 12, context: true, model: "nurse_handoff", threshold: "ai.threshold.nurse_handoff", defaultThreshold: 300, maxWords: 400 },
  EXPLAIN_REPORT: { audience: "PATIENT", keep: 8, context: false, model: "explain_report", threshold: "ai.threshold.explain_report", defaultThreshold: 450, maxWords: 350 },
  HEALTH_TIMELINE: { audience: "PATIENT", keep: 12, context: true, model: "health_timeline", threshold: "ai.threshold.health_timeline", defaultThreshold: 450, maxWords: 450 },
  PREVISIT_QUESTIONS: { audience: "PATIENT", keep: 8, context: false, model: "previsit_questions", threshold: "ai.threshold.previsit_questions", defaultThreshold: 450, maxWords: 200 },
};

export function isAiMode(m: unknown): m is AiMode {
  return typeof m === "string" && (AI_MODES as readonly string[]).includes(m);
}

/** The label every answer carries, in the response and the UI (§9.1). */
export const ADVISORY_LABEL = "AI-generated — advisory only. Check the cited record.";
