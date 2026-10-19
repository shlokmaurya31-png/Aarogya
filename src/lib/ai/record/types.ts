import type { AiAudience, AiMode } from "@/lib/rag/modes";

/**
 * Week 4b — the answer boundary (docs/RAG_DESIGN.md §6.1; ADR 0003): the
 * provider is given only the retrieved, access-checked sources, numbered,
 * and returns sentences that each name the sources they rest on. It never
 * sees an identifier (no name, UHID, phone, address or ABHA number, §9.7) and
 * has no tools. Every claim is validated afterwards (citations retrieved,
 * numbers present in the cited sources) before anyone sees it.
 */
export interface RecordSource {
  /** 1-based; what the provider cites. */
  n: number;
  chunkId: string;
  /** e.g. "[Lab result · CBC · 2026-10-14 · verified]" */
  context: string;
  text: string;
  /** A translation of `text` into the reader's language, when one exists (values stay as in the original). */
  translation?: { language: string; text: string };
}

export interface AnswerRequest {
  mode: AiMode;
  audience: AiAudience;
  /** The language to answer in (ISO 639-1). */
  language: string;
  /** CHART_QA, and follow-ups in EXPLAIN_REPORT. */
  question?: string;
  /** VISIT_BRIEF / PREVISIT_QUESTIONS: the visit's reason, when known. */
  visitReason?: string;
  sources: RecordSource[];
}

/**
 * FACT: says something about the patient, must cite at least one source.
 * GUIDANCE: a fixed, non-factual line ("please ask your care team …"); no
 * citation and no number allowed.
 */
export interface AnswerSentence { text: string; citations: number[]; kind: "FACT" | "GUIDANCE" }

export interface RecordAnswer {
  outcome: "ANSWERED" | "NO_RECORD" | "REFUSED_SAFETY";
  sentences: AnswerSentence[];
  model: string;
  inputTokens: number;
  outputTokens: number;
}

declare const aiPermitBrand: unique symbol;
export interface AiPermit { readonly subject: string; readonly purpose: "AI_ASSISTANCE"; readonly real: boolean; readonly [aiPermitBrand]: true }

export interface RecordAnswerProvider {
  readonly id: "claude" | "mock";
  answerFromRecord(req: AnswerRequest, permit: AiPermit): Promise<RecordAnswer>;
}

/** The provider is down or refused: the API answers 503, never the mock (§6.1). */
export class RecordAiUnavailableError extends Error {
  constructor(readonly code: "PROVIDER_UNAVAILABLE" | "RATE_LIMITED" | "INTERNAL") {
    super(`AI provider unavailable: ${code}`);
    this.name = "RecordAiUnavailableError";
  }
}
