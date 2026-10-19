/**
 * Week 4a/4b — model configuration (`ai.model.*`; docs/RAG_DESIGN.md §6.1,
 * docs/DOCUMENT_PIPELINE_DESIGN.md §6): the pipeline's helpers and one key per
 * AI mode. Each key can be overridden by an
 * environment variable, AI_MODEL_<KEY> (e.g. AI_MODEL_OCR_RETRY). Only a
 * Claude model id is accepted; anything else falls back to the default, so a
 * typo can't silently route patient data to an unexpected model.
 */
export const AI_MODEL_DEFAULTS = {
  ocr: "claude-haiku-5-5",
  ocr_retry: "claude-sonnet-5-5",
  translation: "claude-haiku-5-5",
  extraction: "claude-haiku-5-5",
  tagging: "claude-haiku-5-5",
  // Week 4b — answers over the record, one key per mode (RAG design §6.1).
  // Sonnet 5.5 for every mode, patient-facing ones included (§14).
  visit_brief: "claude-sonnet-5-5",
  chart_qa: "claude-sonnet-5-5",
  nurse_handoff: "claude-sonnet-5-5",
  explain_report: "claude-sonnet-5-5",
  health_timeline: "claude-sonnet-5-5",
  previsit_questions: "claude-sonnet-5-5",
} as const;
export type AiModelKey = keyof typeof AI_MODEL_DEFAULTS;

const CLAUDE_MODEL = /^claude-[a-z0-9-]+$/;

export function aiModel(key: AiModelKey, env: Record<string, string | undefined> = process.env): string {
  const override = env[`AI_MODEL_${key.toUpperCase()}`]?.trim();
  return override && CLAUDE_MODEL.test(override) ? override : AI_MODEL_DEFAULTS[key];
}
