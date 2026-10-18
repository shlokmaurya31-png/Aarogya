import { phrase } from "@/lib/rag/phrases";
import { MODES } from "@/lib/rag/modes";
import { assertAiPermit } from "./permit";
import type { AnswerRequest, AnswerSentence, RecordAnswer, RecordAnswerProvider } from "./types";

/**
 * Week 4b — the deterministic, offline answer provider (CI and local; never
 * over real data). Extractive: every factual sentence is a line of a source,
 * copied verbatim and cited, so it echoes what it was given (the leak gate
 * relies on that: anything retrieved would surface) and never invents a value.
 *
 *   CHART_QA, EXPLAIN_REPORT follow-ups   the lines sharing the most words with
 *                                         the question (at most 3)
 *   VISIT_BRIEF, NURSE_HANDOFF,           every line, in the order given
 *   HEALTH_TIMELINE, EXPLAIN_REPORT
 *   PREVISIT_QUESTIONS                    one question per source, naming it
 *
 * Patient-facing answers open with a fixed line in the reader's language.
 */
const MOCK_MODEL = "mock-record-1";
const STOP = new Set(["the", "a", "an", "of", "is", "was", "are", "were", "what", "which", "when", "her", "his", "their", "did", "does", "do", "on", "in", "for", "to", "and", "or", "with", "any", "has", "have", "had", "this", "that", "patient", "my", "me", "i", "show", "tell", "about", "last", "latest", "current", "recent", "most"]);

export function contentWords(text: string): string[] {
  return text.toLowerCase().normalize("NFKC").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !STOP.has(w));
}

function lines(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter(Boolean);
}

export const mockRecordAnswer: RecordAnswerProvider = {
  id: "mock",
  async answerFromRecord(req: AnswerRequest, permit): Promise<RecordAnswer> {
    assertAiPermit(permit);
    if (permit.real) throw new Error("The mock answer provider never answers over real data.");
    if (!req.sources.length) return { outcome: "NO_RECORD", sentences: [], model: MOCK_MODEL, inputTokens: 0, outputTokens: 0 };
    const all = req.sources.flatMap((s) => lines(s.text).map((text) => ({ text, n: s.n })));
    const out: AnswerSentence[] = [];
    const patient = MODES[req.mode].audience === "PATIENT";
    if (req.mode === "PREVISIT_QUESTIONS") {
      out.push({ text: phrase(req.language, "youCouldAsk"), citations: [], kind: "GUIDANCE" });
      for (const s of req.sources.slice(0, 5)) out.push({ text: `${s.context.replace(/^\[|\]$/g, "")}?`, citations: [s.n], kind: "FACT" });
    } else if (req.question && (req.mode === "CHART_QA" || req.mode === "EXPLAIN_REPORT")) {
      const terms = new Set(contentWords(req.question));
      const scored = all.map((l, i) => ({ ...l, i, score: contentWords(l.text).filter((w) => terms.has(w)).length })).filter((l) => l.score > 0);
      scored.sort((a, b) => b.score - a.score || a.i - b.i);
      const picked = (scored.length ? scored : all.slice(0, 1)).slice(0, 3);
      if (patient) out.push({ text: phrase(req.language, "reportSays"), citations: [], kind: "GUIDANCE" });
      for (const l of picked) out.push({ text: l.text, citations: [l.n], kind: "FACT" });
    } else {
      if (patient) out.push({ text: phrase(req.language, req.mode === "EXPLAIN_REPORT" ? "reportSays" : "recordShows"), citations: [], kind: "GUIDANCE" });
      for (const l of all.slice(0, 24)) out.push({ text: l.text, citations: [l.n], kind: "FACT" });
    }
    return { outcome: "ANSWERED", sentences: out, model: MOCK_MODEL, inputTokens: 0, outputTokens: 0 };
  },
};
