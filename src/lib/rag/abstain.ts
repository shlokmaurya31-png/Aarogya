import { contentWords } from "@/lib/ai/record/mock";
import { ABBREVIATIONS } from "./abbreviations";
import { conceptsIn } from "./lexicon";
import { MEDICINE_VARIANTS, canonicalMedicine } from "./medicineNames";
import { stem } from "./stem";

/**
 * RAG Phase 5, step 3b — "no record" before a wrong answer
 * (docs/RAG_IMPLEMENTATION_PLAN.md §7). The sealed split of Phase 4 found
 * three questions answered that should have been "no record": "HIV status?",
 * "Last ECG findings?" and "How many oxygen cylinders are in stock?". The
 * first two passed the score threshold on their generic words alone
 * ("status", "findings": a diagnosis's status line, an X-ray's findings); no
 * source said anything about HIV or an ECG. The third is a supply question
 * the router sent to the oxygen-saturation reader (router.ts, SUPPLY).
 *
 * The rule here: an English question's subject must be in its evidence. Its
 * salient words (content words that aren't generic: "status", "result",
 * "findings", "level") are the subject; at least one of them, or one of its
 * other names (abbreviations, medicine variants, the lexicon's concept names
 * in every script, the synonyms and the medicine classes), must appear in the
 * sources retrieval chose, or the answer is "no record" without asking the
 * model. A question whose readers answered it has its evidence already, and
 * a question in an Indic script keeps the threshold rule alone (its words
 * reach English sources through the lexicon, which this check also uses, but
 * not every inflection does; recorded as a decision).
 */
const GENERIC = new Set([
  "status", "finding", "findings", "result", "results", "resulted", "value", "values", "level", "levels", "report", "reports", "reported",
  "history", "test", "tests", "tested", "done", "show", "shows", "showed", "shown", "give", "given", "giving", "please", "record", "records",
  "recorded", "chart", "charted", "how", "many", "much", "often", "date", "dates", "time", "times", "reading", "readings", "number", "numbers",
  "check", "checked", "prescribed", "prescription", "taking", "take", "takes", "taken", "she", "he", "him", "patient", "patients", "there",
  "been", "also", "still", "now", "today", "ever", "who", "why", "where", "should", "can", "could", "would", "will", "be", "being", "it",
  "its", "they", "them", "we", "us", "you", "your", "our", "from", "at", "by", "as", "not", "no", "yes", "if", "than", "then", "so", "more",
  "less", "every", "each", "per", "up", "out", "into", "over", "under", "after", "before", "since", "during", "until", "while", "new", "old",
  "previous", "prior", "first", "next", "again", "back", "here", "result's", "values'", "anything", "something", "information", "info",
  "details", "detail", "summary", "note", "notes", "please", "kindly", "tell", "know", "see", "look", "find", "get", "need", "needs", "used",
  "use", "using", "uses", "right", "currently", "presently", "ordered", "order", "orders", "plan", "planned", "pending", "awaited", "awaiting",
  "outstanding", "yet", "all", "some", "other", "others", "same", "type", "kind", "range", "normal", "abnormal", "high", "low", "raised",
  "elevated", "positive", "negative", "trend", "changed", "change", "since", "ago", "days", "day", "week", "weeks", "month", "months", "year",
  "years", "hours", "hour", "minutes", "morning", "evening", "night", "shift", "ward", "bed", "hospital", "doctor", "nurse", "team", "care",
]);
const LATIN_WORD = /^[a-z][a-z0-9'-]*$/;

/** The salient words of a question: Latin content words that name a subject (not generic, not a number). */
export function salientTerms(question: string): string[] {
  return [...new Set(contentWords(question).filter((w) => LATIN_WORD.test(w) && !GENERIC.has(w) && w.length > 1))];
}

/** Extra names for a salient word, from the other modules (medicine classes, synonyms), registered at load. */
const extraExpanders: ((word: string, question: string) => string[])[] = [];
export function registerSubjectExpander(f: (word: string, question: string) => string[]) { extraExpanders.push(f); }

/** A salient word's other names: abbreviations both ways, medicine variants, the lexicon concept's names, then the registered expanders. */
export function subjectForms(word: string, question: string): string[] {
  const out = new Set<string>([word]);
  for (const l of ABBREVIATIONS[word] ?? []) out.add(l);
  for (const [short, longs] of Object.entries(ABBREVIATIONS)) if (longs.some((l) => l === word || l.split(/[\s-]+/).includes(word))) out.add(short);
  const inn = canonicalMedicine(word);
  if (inn) { out.add(inn); for (const v of MEDICINE_VARIANTS[inn] ?? []) out.add(v); }
  for (const c of conceptsIn(word, { romanized: false })) for (const names of Object.values(c.names)) for (const n of names!) out.add(n.toLowerCase().normalize("NFC"));
  for (const f of extraExpanders) for (const x of f(word, question)) out.add(x.toLowerCase().normalize("NFC"));
  return [...out];
}

const fold = (w: string) => stem(w.replace(/ae/g, "e").replace(/oe/g, "e"));

/**
 * Whether the evidence mentions the question's subject. Null when the rule
 * doesn't apply (no salient Latin word: an Indic-script question, or one made
 * only of generic words); otherwise true when some salient word or one of its
 * forms is in the evidence (a Latin form by its words' stems, anything else
 * as written).
 */
export function subjectCovered(question: string, evidence: readonly string[]): boolean | null {
  const salient = salientTerms(question);
  if (!salient.length) return null;
  const text = ` ${evidence.join("\n").toLowerCase().normalize("NFC").replace(/\s+/g, " ")} `;
  const stems = new Set(contentWords(text).map(fold));
  return salient.some((w) => subjectForms(w, question).some((f) => {
    if (LATIN_WORD.test(f)) return stems.has(fold(f)) || text.includes(` ${f} `);
    // A Latin name of several words ("chest x-ray"): every word, in any order ("X-ray Chest PA view").
    if (/^[a-z0-9' -]+$/.test(f)) return contentWords(f).every((w) => stems.has(fold(w)));
    return text.includes(f);
  }));
}
