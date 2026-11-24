import { nlemNames } from "@/lib/medicines/reference";
import { MEDICINE_VARIANTS } from "./medicineNames";
import { LEXICON } from "./lexicon";

/**
 * RAG Phase 4, step 4.2 — deterministic context compression, level 1
 * (docs/RAG_ARCHITECTURE.md §11.3). Applied to the copy of the sources the
 * answer provider is given; the stored source, the citation and the
 * validator keep the original. Lossless for clinical content:
 *
 *   1. whitespace collapsed (runs of spaces; blank lines);
 *   2. a passage's header or footer line repeated across passages of the same
 *      document dropped from all but the first — only when the line carries no
 *      critical fact (below), so each source keeps every one of its facts;
 *   3. the date dropped from a passage's context line when its text already
 *      states it: "[Lab result · Hemoglobin · 2026-10-01 · verified]" over
 *      "Hemoglobin 11.2 g/dL …, resulted 2026-10-01" becomes "[Lab result ·
 *      Hemoglobin · verified]". The kind, the title (which pairs a
 *      patient-provided value with the verified one) and the origin stay.
 *
 * `criticalFacts` is independent of the compressor: what the property test
 * and the gate check survive — every number, unit, date, medicine name, dose,
 * route, frequency, allergy or contraindication word, abnormal finding,
 * negation, uncertainty word and source number.
 */
export interface Compressible { n: number; context: string; text: string; documentId?: string }

const UNITS = ["mg", "mcg", "µg", "g", "kg", "ml", "mL", "l", "L", "iu", "IU", "units", "mmHg", "mmol/L", "mEq/L", "g/dL", "mg/dL", "ng/mL", "µIU/mL", "pg/mL", "U/L", "%", "/min", "°C", "°F", "psi", "mL/kg", "mg/kg", "cells/µL", "x10^9/L"];
const ROUTES = ["oral", "iv", "im", "sc", "inhalation", "topical", "sublingual", "rectal", "intravenous", "intramuscular", "subcutaneous", "nebulised", "nebulized"];
const FREQUENCIES = ["od", "bd", "bid", "tds", "tid", "qid", "hs", "sos", "prn", "stat", "daily", "weekly", "hourly", "nightly"];
const ALLERGY = ["allergy", "allergic", "allergies", "contraindicated", "contraindication", "avoid", "intolerance", "anaphylaxis", "reaction"];
const ABNORMAL = ["high", "low", "critical", "abnormal", "positive", "raised", "elevated", "reduced", "decreased", "increased", "out of range", "consolidation", "opacity", "effusion", "missed", "overdue", "severe"];
const NEGATIONS = ["no", "not", "nil", "none", "never", "without", "denies", "denied", "negative", "absent", "free of", "unremarkable", "नहीं", "नही", "ना", "नको", "নয়", "না", "இல்லை", "లేదు", "ಇಲ್ಲ", "ഇല്ല", "નહીં", "ନାହିଁ", "نہیں", "نہ"];
const ALLERGENS = ["penicillin", "penicillins", "sulfa", "sulfonamide", "sulfonamides", "nsaid", "nsaids", "aspirin", "cephalosporin", "cephalosporins", "latex", "iodine", "contrast", "opioid", "opioids", "egg", "peanut", "shellfish"];
const UNCERTAINTY = ["possible", "possibly", "probable", "probably", "likely", "unlikely", "suggest", "suggests", "suggestive", "suspected", "suspicion", "query", "uncertain", "cannot be excluded", "may", "might", "?"];

let medicineSet: Set<string> | null = null;
function medicineWords(): Set<string> {
  medicineSet ??= new Set([
    ...nlemNames().map((n) => n.toLowerCase()).filter((n) => /^[a-z][a-z-]{3,}$/.test(n)),
    ...Object.entries(MEDICINE_VARIANTS).flatMap(([k, vs]) => [k, ...vs]).map((n) => n.toLowerCase()).filter((n) => !n.includes(" ")),
    ...LEXICON.filter((c) => c.kind === "MEDICINE").flatMap((c) => Object.values(c.names).flat()).map((n) => n!.toLowerCase().normalize("NFC")).filter((n) => !n.includes(" ")),
    // Allergens named by class rather than by an NLEM entry.
    ...ALLERGENS,
  ]);
  return medicineSet;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const wordRe = (ws: readonly string[]) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${[...ws].sort((a, b) => b.length - a.length).map(esc).join("|")})(?![\\p{L}\\p{N}])`, "giu");
const RE = {
  date: /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b|\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4}\b/giu,
  number: /\d+(?:[.,]\d+)?/gu,
  unit: new RegExp(`(?<=\\d\\s?)(?:${[...UNITS].sort((a, b) => b.length - a.length).map(esc).join("|")})(?![\\p{L}])`, "gu"),
  route: wordRe(ROUTES), frequency: wordRe(FREQUENCIES), allergy: wordRe(ALLERGY), abnormal: wordRe(ABNORMAL), negation: wordRe(NEGATIONS),
  uncertainty: new RegExp(`${wordRe(UNCERTAINTY.filter((w) => w !== "?")).source}|\\?`, "giu"),
  sourceNo: /\[\d+\]/gu,
};

export type FactKind = "date" | "number" | "unit" | "medicine" | "route" | "frequency" | "allergy" | "abnormal" | "negation" | "uncertainty" | "sourceNo";

/** The critical facts of a text, as `kind:value` (lower-cased, whitespace-normalised). */
export function criticalFacts(text: string): Set<string> {
  const t = text.normalize("NFC");
  const out = new Set<string>();
  for (const [kind, re] of Object.entries(RE) as [FactKind, RegExp][]) for (const m of t.matchAll(re)) out.add(`${kind}:${m[0].toLowerCase().replace(/\s+/g, " ")}`);
  const meds = medicineWords();
  for (const w of t.toLowerCase().split(/[^\p{L}\p{M}-]+/u)) if (meds.has(w)) out.add(`medicine:${w}`);
  return out;
}

/** The facts of `before` missing from `after` (empty: nothing lost). */
export function lostFacts(before: string, after: string): string[] {
  const kept = criticalFacts(after);
  return [...criticalFacts(before)].filter((f) => !kept.has(f));
}

const collapse = (s: string) => s.replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{2,}/g, "\n").trim();

/** The context line without a date the text already states; the kind, the title and the origin always stay. */
function compactContext(context: string, text: string): string {
  const m = /^\[(.*)\]$/.exec(context.trim());
  if (!m) return context;
  const parts = m[1].split(" · ");
  if (parts.length < 3) return context;
  const lower = text.toLowerCase();
  // Only a date the text already states: the title stays, since it names the entry a disagreement is paired by.
  const middle = parts.slice(1, -1).filter((p) => !(/^\d{4}-\d{2}-\d{2}$/.test(p.trim()) && lower.includes(p.trim())));
  return `[${[parts[0], ...middle, parts[parts.length - 1]].join(" · ")}]`;
}

const hasFact = (line: string) => criticalFacts(line).size > 0;

/**
 * Level 1 on a request's sources (same order, same numbers). Never drops a
 * critical fact from any source: every rule above checks it, and the result
 * is checked again here — a source whose compression lost anything is sent
 * as it was.
 */
export function compressSources<T extends Compressible>(sources: readonly T[]): T[] {
  const seenEdge = new Map<string, Set<string>>();
  return sources.map((s) => {
    let lines = collapse(s.text).split("\n");
    if (s.documentId && lines.length > 1) {
      const seen = seenEdge.get(s.documentId) ?? new Set<string>();
      const drop = (i: number) => lines[i].length >= 12 && !hasFact(lines[i]) && seen.has(lines[i]);
      const first = lines[0], last = lines[lines.length - 1];
      lines = lines.filter((_, i) => !((i === 0 || i === lines.length - 1) && drop(i)));
      seen.add(first); seen.add(last);
      seenEdge.set(s.documentId, seen);
    }
    const text = lines.join("\n");
    const context = compactContext(collapse(s.context), text);
    const before = `[${s.n}] ${s.context}\n${s.text}`, after = `[${s.n}] ${context}\n${text}`;
    return lostFacts(before, after).length ? s : { ...s, context, text };
  });
}
