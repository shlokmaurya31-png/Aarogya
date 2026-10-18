/**
 * Week 4a — model configuration (`ai.model.*`; docs/RAG_DESIGN.md §6.1,
 * docs/DOCUMENT_PIPELINE_DESIGN.md §6). Each key can be overridden by an
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
} as const;
export type AiModelKey = keyof typeof AI_MODEL_DEFAULTS;

const CLAUDE_MODEL = /^claude-[a-z0-9-]+$/;

export function aiModel(key: AiModelKey, env: Record<string, string | undefined> = process.env): string {
  const override = env[`AI_MODEL_${key.toUpperCase()}`]?.trim();
  return override && CLAUDE_MODEL.test(override) ? override : AI_MODEL_DEFAULTS[key];
}
