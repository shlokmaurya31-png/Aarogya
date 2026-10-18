import { DEVANAGARI_STOPWORDS, ENGLISH_STOPWORDS, SUPPORTED_LANGUAGES, type SupportedLanguage } from "./vocab";

/**
 * Week 4a — language detection for a page (docs/DOCUMENT_PIPELINE_DESIGN.md
 * §2.3), deterministic: by Unicode script, then stopwords to tell Marathi from
 * Hindi. Protected spans (values, units, medicine names, analytes) are removed
 * first, since Indian reports print those in English whatever the language.
 *
 *   language   ISO 639-1 of the page; "mixed" when a supported Indic language
 *              and English prose share the page; "und" when the dominant
 *              script isn't one of the supported languages' scripts.
 *   lines      each line's language (null for a line with no letters).
 */
const SCRIPTS: [string, RegExp, SupportedLanguage | null][] = [
  ["Latn", /\p{Script=Latin}/u, "en"],
  ["Deva", /\p{Script=Devanagari}/u, null],
  ["Taml", /\p{Script=Tamil}/u, "ta"],
  ["Beng", /\p{Script=Bengali}/u, "bn"],
  ["Gujr", /\p{Script=Gujarati}/u, "gu"],
  ["Telu", /\p{Script=Telugu}/u, "te"],
  ["Knda", /\p{Script=Kannada}/u, "kn"],
  ["Mlym", /\p{Script=Malayalam}/u, "ml"],
  ["Orya", /\p{Script=Oriya}/u, "or"],
  // Urdu is the only supported language written in the Arabic script.
  ["Arab", /\p{Script=Arabic}/u, "ur"],
];
const LETTER = /\p{L}|\p{M}/u;

export interface DetectedLanguage { language: string; script: string; lines: (string | null)[] }

function scriptOf(ch: string): string {
  for (const [s, re] of SCRIPTS) if (re.test(ch)) return s;
  return "Zyyy";
}

function counts(text: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const ch of text) if (LETTER.test(ch)) m.set(scriptOf(ch), (m.get(scriptOf(ch)) ?? 0) + 1);
  return m;
}

function dominant(m: Map<string, number>): string | null {
  let best: string | null = null;
  for (const [s, n] of m) if (!best || n > m.get(best)!) best = s;
  return best;
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{M}]+/u).filter(Boolean);
}

/** `stripped` lines are the page lines with protected spans removed. */
export function detectLanguage(stripped: readonly string[]): DetectedLanguage {
  const all = stripped.join("\n");
  const ws = words(all);
  const deva: SupportedLanguage = ws.filter((w) => DEVANAGARI_STOPWORDS.mr.includes(w)).length > ws.filter((w) => DEVANAGARI_STOPWORDS.hi.includes(w)).length ? "mr" : "hi";
  const langOf = (script: string) => (script === "Deva" ? deva : SCRIPTS.find(([s]) => s === script)?.[2] ?? "und");
  const lines = stripped.map((l) => { const d = dominant(counts(l)); return d ? langOf(d) : null; });
  const page = counts(all);
  const native = new Map([...page].filter(([s]) => s !== "Latn"));
  const top = dominant(native);
  if (!top) return { language: "en", script: "Latn", lines };
  const language = langOf(top);
  if (language === "und") return { language, script: top, lines };
  const englishProse = stripped.some((l) => words(l).filter((w) => (ENGLISH_STOPWORDS as readonly string[]).includes(w)).length >= 2);
  return { language: englishProse ? "mixed" : language, script: top, lines };
}

export function isSupportedLanguage(l: string): l is SupportedLanguage {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(l);
}
