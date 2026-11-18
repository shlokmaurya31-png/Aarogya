/**
 * RAG Phase 2, step 2.5 — patient identifiers in a knowledge upload
 * (docs/RAG_IMPLEMENTATION_PLAN.md §13 decision 8, §13.1). A knowledge
 * document is the hospital's own reference text (an SOP, a policy, a
 * formulary): it names no patient. A file in which anything looks like a
 * patient identifier is refused whole, and nothing of it is kept.
 *
 * Looks for, by shape only (stricter than exact, by design):
 *   ABHA_NUMBER       14 digits (xx-xxxx-xxxx-xxxx) or an ABHA address (…@abdm, …@sbx)
 *   AADHAAR_NUMBER    12 digits starting 2–9, alone or in groups of four (a masked
 *                     number, XXXX XXXX 1234, is not one)
 *   MOBILE_NUMBER     an Indian mobile (6–9 then nine digits, with or without +91 / 0)
 *   UHID_OR_MRN       this app's UHID (UHID-…), or a UHID / MRN / IP / OP / registration
 *                     number label followed by a value with a digit
 *   NAME_WITH_AGE     a titled name (Mr, Mrs, Shri, Smt, श्री, श्रीमती …) or a two-word
 *                     capitalised name, followed by an age (45 years, 45 yrs, 45/M, aged 45)
 * Short codes and toll-free numbers (112, 108, 1800-…) are none of these.
 *
 * Returns the kinds found, never the text that matched: a refused number is
 * not stored, logged or sent back.
 */
export const IDENTIFIER_KINDS = ["ABHA_NUMBER", "AADHAAR_NUMBER", "MOBILE_NUMBER", "UHID_OR_MRN", "NAME_WITH_AGE"] as const;
export type IdentifierKind = (typeof IDENTIFIER_KINDS)[number];

const ABHA = [/(?<![\d-])\d{2}-\d{4}-\d{4}-\d{4}(?![\d-])/u, /(?<!\d)\d{14}(?!\d)/u, /\b[a-z0-9][a-z0-9._]{2,}@(?:abdm|sbx)\b/iu];
const AADHAAR = [/(?<![\d-])[2-9]\d{3}[ -]\d{4}[ -]\d{4}(?![\d-])/u, /(?<!\d)[2-9]\d{11}(?!\d)/u];
const MOBILE = /(?<![\d+])(?:\+91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/u;
const UHID = [
  /\bUHID-[A-Z0-9]{2,}-[A-Z0-9]{3,}\b/u,
  /\b(?:UHID|MRN|MR\s?No|IP\s?No|OP\s?No|IPD\s?No|OPD\s?No|Reg(?:istration)?\.?\s?No|Hospital\s?No|Patient\s?ID)\b\.?\s*[:#-]?\s*(?=[A-Z0-9/-]*\d)[A-Z0-9][A-Z0-9/-]{2,}/iu,
];

// Words that start a sentence or name a group, never a person ("Adults, 18 years").
const NOT_A_NAME = new Set([
  "adult", "adults", "child", "children", "infant", "infants", "neonate", "neonates", "patient", "patients", "women", "woman", "men", "man",
  "elderly", "adolescent", "adolescents", "age", "ages", "aged", "under", "over", "above", "below", "between", "from", "to", "and", "or",
  "for", "in", "at", "after", "before", "within", "all", "any", "each", "every", "boys", "girls", "pregnant", "pediatric", "paediatric",
  "geriatric", "dose", "doses", "day", "days", "week", "weeks", "month", "months", "year", "years", "the", "a", "an", "of", "with", "less", "more", "than",
  "table", "section", "step", "page", "figure", "annex", "appendix", "chapter", "version", "rev", "revision", "group", "cohort", "category", "class", "level",
]);
const TITLE = String.raw`(?:Mr|Mrs|Ms|Miss|Mst|Master|Shri|Sri|Smt|Kumari|Km|Baby|Dr)\.?`;
const NAME_WORD = String.raw`[A-Z][a-z]+`;
const AGE = String.raw`(?:aged?\s*)?\d{1,3}\s*(?:y|yrs?|years?|yo|Y|Yrs?|Years?)\b(?:\s*(?:old|/\s*[MF]))?|\d{1,3}\s*/\s*[MF]\b`;
const TITLED_NAME_AGE = new RegExp(String.raw`\b${TITLE}\s+${NAME_WORD}(?:\s+${NAME_WORD}){0,3}\s*[,(]?\s*(?:${AGE})`, "u");
const NAME_AGE = new RegExp(String.raw`\b(${NAME_WORD})\s+(${NAME_WORD})(?:\s+(${NAME_WORD}))?\s*[,(]\s*(?:${AGE})`, "gu");
const NAME_LABEL_AGE = /\b(?:Patient(?:'s)?\s+)?Name\s*[:-]\s*[A-Za-z][A-Za-z .]{1,60}?[,;|]?\s*\bAge\s*[:-]?\s*\d{1,3}\b/u;
const INDIC_TITLED_NAME_AGE = /(?:श्री|श्रीमती|सुश्री|कुमारी|श्रीमान)\s*[\p{L}\p{M}]+(?:\s+[\p{L}\p{M}]+){0,3}\s*[,(]?\s*\d{1,3}\s*(?:वर्ष|साल|years?|yrs?)/u;

function hasNameWithAge(text: string): boolean {
  if (TITLED_NAME_AGE.test(text) || NAME_LABEL_AGE.test(text) || INDIC_TITLED_NAME_AGE.test(text)) return true;
  for (const m of text.matchAll(NAME_AGE)) {
    const words = [m[1], m[2], m[3]].filter(Boolean).map((w) => w.toLowerCase());
    if (words.every((w) => !NOT_A_NAME.has(w))) return true;
  }
  return false;
}

/** The kinds of patient identifier the text appears to contain (empty: none). Pure; never returns what matched. */
export function findPatientIdentifiers(text: string): IdentifierKind[] {
  const t = text.normalize("NFKC");
  const found = new Set<IdentifierKind>();
  if (ABHA.some((re) => re.test(t))) found.add("ABHA_NUMBER");
  if (AADHAAR.some((re) => re.test(t))) found.add("AADHAAR_NUMBER");
  if (MOBILE.test(t)) found.add("MOBILE_NUMBER");
  if (UHID.some((re) => re.test(t))) found.add("UHID_OR_MRN");
  if (hasNameWithAge(t)) found.add("NAME_WITH_AGE");
  return IDENTIFIER_KINDS.filter((k) => found.has(k));
}
