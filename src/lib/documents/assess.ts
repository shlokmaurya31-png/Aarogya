import type { ConfidenceBand, ExactCopyCheck, ExtractedFactType } from "@prisma/client";
import type { CandidateFact, Line } from "@/lib/ai/documents/types";
import { COMPLETENESS_FIELDS, EXACT_FIELDS, parseFactValue } from "./factSchemas";
import { bandOf, capBand, lowerBand } from "./confidence";

/**
 * Week 4a — from an extractor's candidates to reviewable facts
 * (docs/DOCUMENT_PIPELINE_DESIGN.md §5.3, §7). Pure: the pipeline's extract
 * step and the evaluation scorer use the same rules.
 *
 *   schema       a candidate whose value fails its type's strict schema is
 *                dropped (counted), never repaired;
 *   exact copy   every exact field occurs verbatim in sourceText, sourceText
 *                occurs in the page's text (whitespace normalized only), and
 *                numericValue parses from value exactly; else FAILED and LOW;
 *   confidence   base: the lowest OCR confidence of the fact's lines;
 *                handwritten: at most MEDIUM; incomplete (a medication without
 *                dose or frequency, a lab value without unit): one band lower;
 *                second-pass disagreement on an exact field: LOW.
 */
export interface AssessedFact {
  factType: ExtractedFactType;
  value: Record<string, unknown>;
  sourceText: string;
  pageNo: number;
  region: [number, number, number, number] | null;
  confidence: number;
  confidenceBand: ConfidenceBand;
  handwritten: boolean;
  exactCopyCheck: ExactCopyCheck;
}

const ws = (s: string) => s.replace(/\s+/g, " ").trim();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `needle` occurs in `hay` as a whole token: not inside a longer word or
 * number ("11" does not occur in "11.2", "mg" not in "mg/dL").
 */
export function occursAsToken(hay: string, needle: string): boolean {
  const n = ws(needle);
  if (!n) return false;
  const before = /^[\p{N}]/u.test(n) ? "(?<![\\p{L}\\p{M}\\p{N}.,/])" : "(?<![\\p{L}\\p{M}\\p{N}])";
  const after = /[\p{N}]$/u.test(n) ? "(?![\\p{L}\\p{M}\\p{N}]|[.,/]\\p{N})" : "(?![\\p{L}\\p{M}\\p{N}]|/\\p{L})";
  return new RegExp(before + esc(n) + after, "u").test(ws(hay));
}

export function exactCopyHolds(factType: ExtractedFactType, value: Record<string, unknown>, sourceText: string, pageText: string): boolean {
  const page = ws(pageText);
  const sources = factType === "DOCUMENT_META" ? sourceText.split("\n") : [sourceText];
  if (!sources.every((s) => ws(s) && page.includes(ws(s)))) return false;
  const src = ws(sourceText);
  for (const f of EXACT_FIELDS[factType]) {
    const v = value[f];
    if (v === undefined) continue;
    if (typeof v !== "string" || !occursAsToken(src, v)) return false;
  }
  if (factType === "LAB_VALUE" && value.numericValue !== undefined) {
    const v = String(value.value);
    if (!/^-?\d+(\.\d+)?$/.test(v) || Number(v) !== value.numericValue) return false;
  }
  return true;
}

function regionOf(layout: readonly Line[], lines: readonly number[]): [number, number, number, number] | null {
  const boxes = lines.map((i) => layout[i]?.bbox).filter((b): b is [number, number, number, number] => !!b);
  if (!boxes.length) return null;
  const x0 = Math.min(...boxes.map((b) => b[0])), y0 = Math.min(...boxes.map((b) => b[1]));
  const x1 = Math.max(...boxes.map((b) => b[0] + b[2])), y1 = Math.max(...boxes.map((b) => b[1] + b[3]));
  const r4 = (x: number) => Math.round(x * 10_000) / 10_000;
  return [r4(x0), r4(y0), r4(x1 - x0), r4(y1 - y0)];
}

/** The lines a fact came from: the extractor's, if valid; else the lines containing its source. */
function linesOf(c: CandidateFact, layout: readonly Line[]): number[] {
  const valid = c.lines.filter((i) => Number.isInteger(i) && i >= 0 && i < layout.length);
  if (valid.length) return valid;
  const parts = c.sourceText.split("\n").map(ws);
  return layout.flatMap((l, i) => (parts.some((p) => p && ws(l.text).includes(p)) ? [i] : []));
}

function sameExact(a: CandidateFact, b: CandidateFact): boolean {
  return EXACT_FIELDS[a.factType].every((f) => (a.value[f] ?? null) === (b.value[f] ?? null));
}

export function assessCandidates(
  page: { pageNo: number; text: string; layout: readonly Line[]; handwritten: boolean; confidence: number },
  candidates: readonly CandidateFact[],
  secondPass?: readonly CandidateFact[],
): { facts: AssessedFact[]; dropped: number } {
  const facts: AssessedFact[] = [];
  let dropped = 0;
  for (const c of candidates) {
    const parsed = parseFactValue(c.factType, c.value);
    if (!parsed.success) { dropped += 1; continue; }
    const value = parsed.data as Record<string, unknown>;
    const lines = linesOf(c, page.layout);
    const confidence = lines.length ? Math.min(...lines.map((i) => page.layout[i].confidence)) : page.confidence;
    const exact = exactCopyHolds(c.factType, value, c.sourceText, page.text);
    let band = bandOf(confidence);
    if (page.handwritten) band = capBand(band, "MEDIUM");
    if ((COMPLETENESS_FIELDS[c.factType] ?? []).some((f) => value[f] === undefined)) band = lowerBand(band);
    if (secondPass) {
      const twin = secondPass.find((o) => o.factType === c.factType && ws(o.sourceText) === ws(c.sourceText));
      if (!twin || !sameExact({ ...c, value }, twin)) band = "LOW";
    }
    if (!exact) band = "LOW";
    facts.push({ factType: c.factType, value, sourceText: c.sourceText, pageNo: page.pageNo, region: regionOf(page.layout, lines), confidence: Math.round(confidence * 1000) / 1000, confidenceBand: band, handwritten: page.handwritten, exactCopyCheck: exact ? "PASSED" : "FAILED" });
  }
  return { facts, dropped };
}

/** Identifier placeholders (⟦In⟧) for text going to an extractor, restored in what comes back. */
export function maskIdentifierLines(lines: readonly string[], spansOf: (t: string) => { start: number; end: number }[]) {
  const originals: string[] = [];
  const index = new Map<string, number>();
  const masked = lines.map((t) => {
    const spans = [...spansOf(t)].sort((a, b) => a.start - b.start || b.end - a.end);
    let out = "", at = 0;
    for (const s of spans) {
      if (s.start < at) continue;
      const orig = t.slice(s.start, s.end);
      if (!index.has(orig)) { originals.push(orig); index.set(orig, originals.length); }
      out += t.slice(at, s.start) + `⟦I${index.get(orig)}⟧`;
      at = s.end;
    }
    return out + t.slice(at);
  });
  const restoreText = (s: string) => s.replace(/⟦I(\d+)⟧/g, (m, n) => originals[Number(n) - 1] ?? m);
  const restoreDeep = (v: unknown): unknown => typeof v === "string" ? restoreText(v) : Array.isArray(v) ? v.map(restoreDeep) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, restoreDeep(x)])) : v;
  return { masked, restoreText, restoreDeep };
}
