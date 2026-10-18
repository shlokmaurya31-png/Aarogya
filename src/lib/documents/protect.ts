/**
 * Week 4a — exact-copy protection (docs/DOCUMENT_PIPELINE_DESIGN.md §5).
 *
 * Medicine names, doses, units, numbers and lab values are found as spans,
 * replaced by placeholders (⟦P1⟧, ⟦P2⟧, …) before text goes to a translator,
 * and restored from the stored originals afterwards. A translation whose
 * placeholders don't come back exactly once each is refused (never shown).
 * The translator never sees a protected value it could alter.
 */

export type SpanKind = "NUMBER" | "UNIT" | "DOSE" | "MEDICINE" | "ANALYTE" | "TAGGED";
export interface Span { start: number; end: number; kind: SpanKind }

export const UNITS = [
  "mg/dL", "g/dL", "mmol/L", "mEq/L", "µmol/L", "umol/L", "ng/mL", "pg/mL", "µg/dL", "IU/L", "U/L", "mIU/L", "µIU/mL", "uIU/mL",
  "x10^3/µL", "x10^6/µL", "x10^3/uL", "/µL", "/uL", "/cumm", "cells/cumm", "mm/hr", "mmHg", "bpm", "fL", "pg",
  "mg", "mcg", "µg", "g", "kg", "ml", "mL", "L", "IU", "units", "%",
] as const;

export const DOSE_NOTATIONS = ["OD", "BD", "BID", "TDS", "TID", "QID", "HS", "SOS", "PRN", "STAT", "AC", "PC", "QHS"] as const;

export const ANALYTES = [
  "Haemoglobin", "Hemoglobin", "Hb", "HbA1c", "Glucose", "Fasting Blood Sugar", "FBS", "PPBS", "RBS", "Creatinine", "Urea", "BUN",
  "Sodium", "Potassium", "Chloride", "TSH", "T3", "T4", "Free T4", "Cholesterol", "Total Cholesterol", "HDL", "LDL", "Triglycerides",
  "SGPT", "ALT", "SGOT", "AST", "ALP", "Bilirubin", "Total Bilirubin", "Albumin", "Platelets", "Platelet Count", "WBC", "TLC", "RBC",
  "ESR", "CRP", "Vitamin D", "Vitamin B12", "Uric Acid", "Calcium", "INR", "PCV", "MCV", "MCH", "MCHC", "eGFR",
] as const;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Word-ish boundaries that also work next to Indic scripts and punctuation. */
const bounded = (alt: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${alt})(?![\\p{L}\\p{N}])`, "giu");

function byLengthDesc(xs: readonly string[]) {
  return [...new Set(xs)].sort((a, b) => b.length - a.length).map(escape).join("|");
}

/**
 * The protected spans of `text`: numbers (decimals, ranges, ratios, dates),
 * units, dose and frequency notation (incl. 1-0-1 and "x 5 days"), medicine
 * names from `dictionary`, lab analytes, and any extra spans (model tagging).
 * Overlaps merge into the longest covering span. Protection is only ever
 * added: no source can remove a span another found.
 */
export function protectedSpans(text: string, dictionary: readonly string[], extra: readonly Span[] = []): Span[] {
  const found: Span[] = [...extra];
  const push = (re: RegExp, kind: SpanKind) => { for (const m of text.matchAll(re)) found.push({ start: m.index!, end: m.index! + m[0].length, kind }); };
  // Dose patterns first (1-0-1, 1-1-1, ½-0-½, x 5 days).
  push(/(?<![\p{N}])[0-9½¼]+(?:\s*-\s*[0-9½¼]+){2,3}(?![\p{N}])/gu, "DOSE");
  push(/[x×]\s*\d+\s*(?:days?|weeks?|months?|din|दिन)/giu, "DOSE");
  push(bounded(byLengthDesc(DOSE_NOTATIONS)), "DOSE");
  // Numbers with what binds to them: 120/80, 4.0-6.0, 4.0–6.0, 12,500, dates.
  push(/(?<![\p{L}\p{N}])\d+(?:[.,]\d+)*(?:\s*[-–/]\s*\d+(?:[.,]\d+)*)*(?![\p{N}])/gu, "NUMBER");
  push(bounded(byLengthDesc(UNITS)), "UNIT");
  if (dictionary.length) push(bounded(byLengthDesc(dictionary)), "MEDICINE");
  push(bounded(byLengthDesc(ANALYTES)), "ANALYTE");
  // Merge overlaps (longest covering span wins; kinds by priority of the first found).
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];
  for (const s of found) {
    const last = merged[merged.length - 1];
    if (last && s.start < last.end) { if (s.end > last.end) last.end = s.end; continue; }
    merged.push({ ...s });
  }
  return merged;
}

export interface Masked { masked: string; originals: string[]; spans: Span[] }

export function mask(text: string, spans: readonly Span[]): Masked {
  let out = "";
  let at = 0;
  const originals: string[] = [];
  for (const s of spans) {
    out += text.slice(at, s.start);
    originals.push(text.slice(s.start, s.end));
    out += `⟦P${originals.length}⟧`;
    at = s.end;
  }
  return { masked: out + text.slice(at), originals, spans: [...spans] };
}

/** Every placeholder ⟦Pn⟧ for n = 1..count exactly once, and no other. */
export function placeholdersIntact(translated: string, count: number): boolean {
  const seen = [...translated.matchAll(/⟦P(\d+)⟧/g)].map((m) => Number(m[1]));
  if (seen.length !== count) return false;
  const set = new Set(seen);
  if (set.size !== count) return false;
  for (let i = 1; i <= count; i++) if (!set.has(i)) return false;
  return true;
}

/** Restores the originals; throws if any placeholder is missing, duplicated or invented. */
export function restore(translated: string, originals: readonly string[]): string {
  if (!placeholdersIntact(translated, originals.length)) throw new ExactCopyViolation();
  return translated.replace(/⟦P(\d+)⟧/g, (_, n) => originals[Number(n) - 1]);
}

export class ExactCopyViolation extends Error {
  constructor() {
    super("The translation did not keep every protected value exactly once.");
    this.name = "ExactCopyViolation";
  }
}

/**
 * The other half of the exact-copy check: every number in the source was
 * masked, so a digit (any script: ASCII, Devanagari, Bengali, Tamil, …)
 * outside a placeholder in the translator's output was invented. Refused.
 */
export function noInventedNumbers(translatedMasked: string): boolean {
  return !/\p{Nd}/u.test(translatedMasked.replace(/⟦P\d+⟧/g, ""));
}
