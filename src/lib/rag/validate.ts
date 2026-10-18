import type { AnswerSentence } from "@/lib/ai/record/types";

/**
 * Week 4b — every sentence is checked before anyone sees it
 * (docs/RAG_DESIGN.md §8.2, §9.4):
 *   - a FACT cites at least one source, and every citation names a source the
 *     retrieval returned;
 *   - every number in a FACT occurs in the original text (or context line) of a
 *     source it cites — never from a translation, never rounded;
 *   - a GUIDANCE line cites nothing and states no number (the emergency
 *     number 112 excepted).
 * The first sentence that fails stops a staff answer there (sentences
 * before it were already released); a patient answer is withheld whole.
 */
export interface SourceText { n: number; text: string; context: string }

export type SentenceCheck = { ok: true } | { ok: false; reason: "NO_CITATION" | "UNKNOWN_CITATION" | "NUMBER_NOT_IN_SOURCE" | "GUIDANCE_WITH_FACTS" };

/** Numbers as written (decimals, ranges' ends, dates' parts), normalized: "1,000" → "1000", "07" → "7". */
export function numbersIn(text: string): string[] {
  return (text.match(/\d+(?:[.,]\d+)*/g) ?? []).map((n) => n.replace(/,(?=\d{3}\b)/g, "").replace(/^0+(?=\d)/, ""));
}

export function checkSentence(s: AnswerSentence, sources: Map<number, SourceText>): SentenceCheck {
  if (s.kind === "GUIDANCE") {
    return s.citations.length || numbersIn(s.text).some((n) => n !== "112") ? { ok: false, reason: "GUIDANCE_WITH_FACTS" } : { ok: true };
  }
  if (!s.citations.length) return { ok: false, reason: "NO_CITATION" };
  const cited = s.citations.map((n) => sources.get(n));
  if (cited.some((c) => !c)) return { ok: false, reason: "UNKNOWN_CITATION" };
  const available = new Set(cited.flatMap((c) => numbersIn(`${c!.context}\n${c!.text}`)));
  return numbersIn(s.text).every((n) => available.has(n)) ? { ok: true } : { ok: false, reason: "NUMBER_NOT_IN_SOURCE" };
}
