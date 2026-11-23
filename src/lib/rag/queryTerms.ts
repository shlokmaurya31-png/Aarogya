import { contentWords } from "@/lib/ai/record/mock";
import { abbreviationTerms } from "./abbreviations";
import { medicineTerms } from "./medicineNames";
import { lexiconTerms } from "./lexicon";
import { latinSkeleton, QUERY_SCRIPTS, romanizeWord, scriptOf, transliterateLatin } from "./romanize";

/**
 * RAG Phase 3, steps 3.5, 3.9, 3.10 — the words each keyword matcher gets
 * for one question (docs/RAG_ARCHITECTURE.md §6.3). Expansion only ADDS
 * words; `original` (the question's own content words) is what a chart's
 * "no record" rule counts, so an expansion can never turn a missing answer
 * into a found one by itself.
 *
 *   exact     'simple' tsvector: the question's words, abbreviations' long
 *             forms (3.5), medicine names' variants (3.5)
 *   english   English stems: the Latin words among the above (3.5)
 *   shadow    the romanised shadow text, exactly: every word as its Latin
 *             skeleton (3.9)
 *   trigram   word similarity: Indic words against the text (inflection,
 *             3.5), Latin words of five letters or more against the text
 *             (typing errors, 3.5), skeletons against the shadow text and
 *             Latin words transliterated into each Indic script against the
 *             text (3.9)
 *   expansion the lexicon's other names for a concept the question names
 *             (3.10), exactly — matched apart and weighted below the
 *             question's own words, so a line in the question's language
 *             ranks above the same concept in another
 */
export interface QueryFeatures { abbreviations: boolean; medicines: boolean; trigram: boolean; shadow: boolean; lexicon: boolean }
export const ALL_FEATURES: QueryFeatures = { abbreviations: true, medicines: true, trigram: true, shadow: true, lexicon: true };

let override: QueryFeatures | null = null;
/** The evaluation's comparison of steps 3.9 and 3.10, each on its own (scripts only). */
export function setQueryFeaturesForTest(f: QueryFeatures | null) { override = f; }
export const queryFeatures = (): QueryFeatures => override ?? ALL_FEATURES;

export interface QueryTerms {
  original: string[]; exact: string[]; english: string[]; shadow: string[]; trigramText: string[]; trigramShadow: string[];
  /** Step 3.9: Latin words written in each Indic script, compared with the text of chunks that have Indic text only. */
  trigramTranslit: string[];
  /** Step 3.5: Latin words of five letters or more, for typing errors; search.ts keeps only those with no exact match in the scope. */
  trigramLatin: string[];
  /** Step 3.10: the lexicon's other names, matched exactly, separately, and weighted below the question's own words (search.ts). */
  expansion: { exact: string[] };
}

const LATIN = /^[a-z0-9]+$/;
const MAX_TRIGRAM = 24;

export function queryTerms(question: string, f: QueryFeatures = queryFeatures()): QueryTerms {
  const original = [...new Set(contentWords(question))];
  const abbr = f.abbreviations ? abbreviationTerms(question) : [];
  const med = f.medicines ? medicineTerms(original) : [];
  const lex = f.lexicon ? lexiconTerms(question, { romanized: f.shadow }) : [];
  const exact = [...new Set([...original, ...abbr, ...med])].filter((w) => w.length > 1);
  const lexExact = lex.filter((w) => w.length > 1 && !exact.includes(w));
  const english = [...new Set([...original, ...abbr, ...med].filter((w) => LATIN.test(w)))];
  const shadow = f.shadow ? [...new Set(exact.map((w) => (LATIN.test(w) ? latinSkeleton(w) : latinSkeleton(romanizeWord(w)))).filter((w) => w.length > 2))] : [];
  const trigramText: string[] = [];
  const trigramShadow: string[] = [];
  const trigramTranslit: string[] = [];
  if (f.trigram) {
    for (const w of original) if (!LATIN.test(w) && [...w].length >= 3) trigramText.push(w);
  }
  if (f.shadow) {
    for (const w of shadow) if (w.length >= 4) trigramShadow.push(w);
    for (const w of original) if (LATIN.test(w) && w.length >= 4 && !/^\d+$/.test(w)) for (const s of QUERY_SCRIPTS) trigramTranslit.push(transliterateLatin(w, s));
  }
  return {
    original, exact, english, shadow,
    expansion: { exact: lexExact },
    trigramText: [...new Set(trigramText.filter((w) => w && (!scriptOf([...w][0]) || [...w].length >= 2)))].slice(0, MAX_TRIGRAM),
    trigramShadow: [...new Set(trigramShadow)].slice(0, MAX_TRIGRAM),
    trigramLatin: f.trigram ? original.filter((w) => LATIN.test(w) && w.length >= 5 && !/^\d+$/.test(w)).slice(0, MAX_TRIGRAM) : [],
    trigramTranslit: [...new Set(trigramTranslit.filter((w) => [...w].length >= 2))].slice(0, MAX_TRIGRAM),
  };
}
