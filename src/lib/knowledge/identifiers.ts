/**
 * RAG Phase 2, step 2.5; rules revised before Phase 3 (docs/RAG_IMPLEMENTATION_PLAN.md
 * §13 decision 8, §13.4 C) — patient identifiers in a knowledge upload. A
 * knowledge document is the hospital's own reference text (an SOP, a policy,
 * a formulary): it names no patient.
 *
 * Refused outright (the whole file; nothing of it is kept):
 *   ABHA_NUMBER       14 digits (xx-xxxx-xxxx-xxxx) or an ABHA address (…@abdm, …@sbx)
 *   AADHAAR_NUMBER    12 digits, not starting 0 or 1, alone or in groups of four, that
 *                     pass the Verhoeff checksum every issued Aadhaar number carries
 *                     (a masked number, XXXX XXXX 1234, is not one)
 *   UHID_OR_MRN       this app's UHID (UHID-…), or a UHID / MRN / IP / OP / registration
 *                     number label followed by a value with a digit
 *   NAME_WITH_AGE     a titled name (Mr, Mrs, Shri, Smt, श्री, श्रीमती …) or a two-word
 *                     capitalised name, followed by an age (45 years, 45 yrs, 45/M, aged 45)
 *
 * Highlighted for the approver (kept, shown, acknowledged before approval):
 *   TWELVE_DIGIT_NUMBER  any other 12-digit number (fails the checksum, or starts 0 or 1)
 *   MOBILE_NUMBER        an Indian mobile (6–9 then nine digits, with or without +91 / 0)
 *                        that is not on the facility's published contact list; a number
 *                        on the list (switchboard, helpline, ambulance) is allowed
 * Short codes and toll-free numbers (112, 108, 1800-…) are none of these.
 *
 * A refusal returns the kinds found, never the text that matched. A
 * highlight carries its position only, so the caller can show a masked
 * excerpt; the number itself is never stored.
 */
export const IDENTIFIER_KINDS = ["ABHA_NUMBER", "AADHAAR_NUMBER", "UHID_OR_MRN", "NAME_WITH_AGE"] as const;
export type IdentifierKind = (typeof IDENTIFIER_KINDS)[number];
export const HIGHLIGHT_KINDS = ["TWELVE_DIGIT_NUMBER", "MOBILE_NUMBER"] as const;
export type HighlightKind = (typeof HIGHLIGHT_KINDS)[number];

export interface IdentifierHighlight { kind: HighlightKind; start: number; end: number }
export interface IdentifierScan { refused: IdentifierKind[]; highlights: IdentifierHighlight[] }

const ABHA = [/(?<![\d-])\d{2}-\d{4}-\d{4}-\d{4}(?![\d-])/u, /(?<!\d)\d{14}(?!\d)/u, /\b[a-z0-9][a-z0-9._]{2,}@(?:abdm|sbx)\b/iu];
const TWELVE = [/(?<![\d-])\d{4}[ -]\d{4}[ -]\d{4}(?![\d-])/gu, /(?<!\d)\d{12}(?!\d)/gu];
const MOBILE = /(?<![\d+])(?:\+91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/gu;
const UHID = [
  /\bUHID-[A-Z0-9]{2,}-[A-Z0-9]{3,}\b/u,
  /\b(?:UHID|MRN|MR\s?No|IP\s?No|OP\s?No|IPD\s?No|OPD\s?No|Reg(?:istration)?\.?\s?No|Hospital\s?No|Patient\s?ID)\b\.?\s*[:#-]?\s*(?=[A-Z0-9/-]*\d)[A-Z0-9][A-Z0-9/-]{2,}/iu,
];

// ── Verhoeff (the Aadhaar check digit) ──────────────────────────────────────
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1], [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1], [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/** True when a string of digits passes the Verhoeff checksum. */
export function verhoeffValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let c = 0;
  const r = [...digits].reverse();
  for (let i = 0; i < r.length; i++) c = D[c][P[i % 8][Number(r[i])]];
  return c === 0;
}

/** Twelve digits that could be an issued Aadhaar number: not starting 0 or 1, and the checksum holds. */
export function looksLikeAadhaar(digits: string): boolean {
  return /^[2-9]\d{11}$/.test(digits) && verhoeffValid(digits);
}

/** An Indian mobile as its ten digits (the +91 or 0 prefix and separators dropped), or null. */
export function normalizeMobile(s: string): string | null {
  const d = s.replace(/\D/g, "");
  const ten = d.length === 12 && d.startsWith("91") ? d.slice(2) : d.length === 11 && d.startsWith("0") ? d.slice(1) : d;
  return /^[6-9]\d{9}$/.test(ten) ? ten : null;
}

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

/**
 * The refusals and the highlights in a text. `allowedMobiles` is the
 * facility's published contact list as ten-digit numbers. Positions are on
 * the text as given (NFKC-normalised first, as the caller should pass it).
 */
export function scanIdentifiers(text: string, opts: { allowedMobiles?: ReadonlySet<string> } = {}): IdentifierScan {
  const t = text.normalize("NFKC");
  const found = new Set<IdentifierKind>();
  const highlights: IdentifierHighlight[] = [];
  if (ABHA.some((re) => re.test(t))) found.add("ABHA_NUMBER");
  const seen = new Set<number>();
  for (const re of TWELVE) {
    for (const m of t.matchAll(re)) {
      if (seen.has(m.index!)) continue;
      seen.add(m.index!);
      if (looksLikeAadhaar(m[0].replace(/\D/g, ""))) found.add("AADHAAR_NUMBER");
      else highlights.push({ kind: "TWELVE_DIGIT_NUMBER", start: m.index!, end: m.index! + m[0].length });
    }
  }
  for (const m of t.matchAll(MOBILE)) {
    const ten = normalizeMobile(m[0]);
    if (ten && opts.allowedMobiles?.has(ten)) continue;
    highlights.push({ kind: "MOBILE_NUMBER", start: m.index!, end: m.index! + m[0].length });
  }
  if (UHID.some((re) => re.test(t))) found.add("UHID_OR_MRN");
  if (hasNameWithAge(t)) found.add("NAME_WITH_AGE");
  highlights.sort((a, b) => a.start - b.start);
  return { refused: IDENTIFIER_KINDS.filter((k) => found.has(k)), highlights };
}

/** The kinds of patient identifier that refuse a file (empty: none). Pure; never returns what matched. */
export function findPatientIdentifiers(text: string): IdentifierKind[] {
  return scanIdentifiers(text).refused;
}

/** Every digit but the last four replaced ("98765 43210" → "•••••3210"; separators dropped). */
export function maskNumber(s: string): string {
  const d = s.replace(/\D/g, "");
  return `${"•".repeat(Math.max(0, d.length - 4))}${d.slice(-4)}`;
}

/**
 * What the approver sees of a highlight: up to 60 characters either side,
 * the number itself masked to its last four digits, and every other run of
 * seven or more digits in the excerpt masked the same way.
 */
export function highlightExcerpt(text: string, h: { start: number; end: number }): string {
  const t = text.normalize("NFKC");
  const from = Math.max(0, h.start - 60), to = Math.min(t.length, h.end + 60);
  const maskRuns = (s: string) => s.replace(/\d[\d -]{5,}\d/g, (m) => (m.replace(/\D/g, "").length >= 7 ? maskNumber(m) : m));
  const before = maskRuns(t.slice(from, h.start)), after = maskRuns(t.slice(h.end, to));
  return `${from > 0 ? "…" : ""}${before}[${maskNumber(t.slice(h.start, h.end))}]${after}${to < t.length ? "…" : ""}`.replace(/\s+/g, " ").trim();
}
