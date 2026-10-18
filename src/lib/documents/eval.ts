import type { ExtractedFactType } from "@prisma/client";
import { createHash } from "node:crypto";
import type { DocumentProviders, ProcessingPermit } from "@/lib/ai/documents/types";
import { mockControl } from "@/lib/ai/documents/mock";
import { FIXTURES, fixturePdf, ocrLines } from "./fixtures";
import type { DocumentFixture, ExpectedFact } from "./fixtures/types";
import { EXACT_FIELDS, factFields } from "./factSchemas";
import { assessCandidates, maskIdentifierLines, type AssessedFact } from "./assess";
import { identifierSpans } from "./identifiers";
import { detectLanguage } from "./language";
import { splitPdf, stripProtected, translateText } from "./steps";
import { normalizePageImage } from "./normalize";
import { renderFixturePage } from "./fixtures/render";

/**
 * Week 4a — the evaluation (docs/DOCUMENT_PIPELINE_DESIGN.md §10.2). Runs each
 * synthetic sample through the pipeline's own steps (page split, OCR,
 * language, translation with the exact-copy check, extraction from the
 * original, assessment), then a simulated review that confirms only the facts
 * the fixture says are right, and scores:
 *
 *   exactness        every exact field of every confirmed fact equals the
 *                    printed source byte for byte (target 100%)
 *   field accuracy   per expected field, right or not (missing facts count as
 *                    wrong): printed ≥ 90%, handwritten ≥ 75% (provisional)
 *   precision        per extracted field
 *   calibration      share of wrong extracted facts in the LOW band
 *   translation      pages translated, exact-copy failures (never shown)
 *
 * With the mocks (CI) this is a plumbing check of gating and exactness, not of
 * model quality; the real-provider run is manual (scripts/eval-documents.ts).
 */
export const TARGETS = { exactness: 1, printed: 0.9, handwritten: 0.75 } as const;

const canon = (v: unknown) => JSON.stringify(v, Object.keys((v ?? {}) as object).sort());
const misread = (f: DocumentFixture, text: string) => Object.entries(f.misreads).reduce((t, [a, b]) => t.split(a).join(b), text);

export interface SampleScore {
  id: string; language: string; handwritten: boolean; category: string;
  expectedFields: number; correctFields: number; extractedFields: number; correctExtractedFields: number;
  confirmedFacts: number; confirmedExact: number; confirmedExactFields: number; wrongFacts: number; wrongFactsLow: number;
  translatedPages: number; translationFailures: number; dropped: number; facts: number;
}

function matchKey(type: ExtractedFactType, sourceText: string | undefined) {
  return `${type}|${sourceText ?? ""}`;
}

/**
 * What the OCR provider is given: the marker PDFs (CI; the mock reads their
 * marker), or the rendered page images in each sample's own script, normalized
 * as the pipeline normalizes a phone photo (the real run).
 */
export type EvalInput = "marker-pdf" | "rendered-image";

async function samplePages(f: DocumentFixture, input: EvalInput, providers: DocumentProviders): Promise<{ bytes: Buffer; contentType: string }[]> {
  if (input === "marker-pdf") {
    const pages = await splitPdf(await fixturePdf(f));
    if (typeof pages === "string") throw new Error(`${f.id}: ${pages}`);
    return pages.map((bytes) => ({ bytes, contentType: "application/pdf" }));
  }
  const out: { bytes: Buffer; contentType: string }[] = [];
  for (let n = 1; n <= f.pages.length; n++) {
    const page = await normalizePageImage(await renderFixturePage(f, n));
    if (typeof page === "string") throw new Error(`${f.id}: ${page}`);
    // The OCR mock reads an image page by its sha256.
    if (providers.ocr.id === "mock") mockControl.imagePages.set(createHash("sha256").update(page.bytes).digest("hex"), `${f.id}#${n}`);
    out.push({ bytes: page.bytes, contentType: page.contentType });
  }
  return out;
}

export async function scoreSample(f: DocumentFixture, providers: DocumentProviders, permit: ProcessingPermit, dictionary: readonly string[], input: EvalInput = "marker-pdf"): Promise<SampleScore> {
  const pages = await samplePages(f, input, providers);
  const s: SampleScore = { id: f.id, language: f.language, handwritten: f.handwritten, category: f.category, expectedFields: 0, correctFields: 0, extractedFields: 0, correctExtractedFields: 0, confirmedFacts: 0, confirmedExact: 0, confirmedExactFields: 0, wrongFacts: 0, wrongFactsLow: 0, translatedPages: 0, translationFailures: 0, dropped: 0, facts: 0 };
  const assessed: AssessedFact[] = [];
  for (const [i, pageInput] of pages.entries()) {
    const ocr = await providers.ocr.ocrPage(pageInput, {}, permit);
    const lang = detectLanguage(ocr.layout.map((l) => stripProtected(l.text, dictionary)));
    if (lang.language !== f.targetLanguage) {
      const tr = await translateText(ocr.text, lang.language, f.targetLanguage, dictionary, [f.patientName], providers, permit);
      s.translatedPages += tr.check === "PASSED" ? 1 : 0;
      s.translationFailures += tr.check === "FAILED" ? 1 : 0;
    }
    const ids = maskIdentifierLines(ocr.layout.map((l) => l.text), (t) => identifierSpans(t, [f.patientName]));
    const page = { text: ids.masked.join("\n"), layout: ocr.layout.map((l, j) => ({ ...l, text: ids.masked[j] })), language: lang.language };
    const restore = (cs: Awaited<ReturnType<DocumentProviders["extraction"]["extract"]>>["facts"]) => cs.map((c) => ({ ...c, value: ids.restoreDeep(c.value) as Record<string, unknown>, sourceText: ids.restoreText(c.sourceText) }));
    const first = restore((await providers.extraction.extract(page, permit)).facts);
    const second = ocr.handwritten ? restore((await providers.extraction.extract(page, permit, { pass: 2 })).facts) : undefined;
    const r = assessCandidates({ pageNo: i + 1, text: ocr.text, layout: ocr.layout, handwritten: ocr.handwritten, confidence: ocr.confidence }, first, second);
    s.dropped += r.dropped;
    assessed.push(...r.facts);
  }
  s.facts = assessed.length;

  // Match each expected fact to the extracted fact read from its (OCR'd) line.
  const byKey = new Map<string, AssessedFact>();
  for (const a of assessed) byKey.set(a.factType === "DOCUMENT_META" ? matchKey(a.factType, "") : matchKey(a.factType, a.sourceText), a);
  const expectedOf = new Map<AssessedFact, ExpectedFact>();
  for (const e of f.expected) {
    const a = byKey.get(e.factType === "DOCUMENT_META" ? matchKey(e.factType, "") : matchKey(e.factType, misread(f, e.sourceText!)));
    const fields = factFields(e.value);
    s.expectedFields += fields.length;
    if (!a) continue;
    expectedOf.set(a, e);
    s.correctFields += fields.filter((k) => canon(a.value[k]) === canon(e.value[k])).length;
  }
  for (const a of assessed) {
    const e = expectedOf.get(a);
    const fields = factFields(a.value);
    s.extractedFields += fields.length;
    const right = !!e && canon(a.value) === canon(e.value);
    if (e) s.correctExtractedFields += fields.filter((k) => canon(a.value[k]) === canon(e.value[k])).length;
    if (!right) { s.wrongFacts += 1; if (a.confidenceBand === "LOW") s.wrongFactsLow += 1; }
    // Simulated review: confirm only what the fixture says is right (and only what the review rules allow).
    if (right && a.exactCopyCheck === "PASSED") {
      s.confirmedFacts += 1;
      const printed = e!.sourceText ?? "";
      const exact = EXACT_FIELDS[a.factType].filter((k) => a.value[k] !== undefined);
      s.confirmedExactFields += exact.length;
      if (exact.every((k) => printed.includes(String(a.value[k])) && a.sourceText.includes(String(a.value[k])))) s.confirmedExact += 1;
    }
  }
  return s;
}

export interface EvalReport {
  samples: SampleScore[];
  exactness: number; printed: number; handwritten: number; precision: number; calibration: number;
  translatedPages: number; translationFailures: number;
  byLanguage: Record<string, number>; byCategory: Record<string, number>;
  languages: string[]; handwrittenSamples: number;
}

const ratio = (a: number, b: number) => (b === 0 ? 1 : a / b);

export async function runEvaluation(providers: DocumentProviders, permit: ProcessingPermit, dictionary: readonly string[], fixtures: readonly DocumentFixture[] = FIXTURES, input: EvalInput = "marker-pdf"): Promise<EvalReport> {
  const samples: SampleScore[] = [];
  for (const f of fixtures) samples.push(await scoreSample(f, providers, permit, dictionary, input));
  const sum = (xs: SampleScore[], k: keyof SampleScore) => xs.reduce((n, x) => n + (x[k] as number), 0);
  const acc = (xs: SampleScore[]) => ratio(sum(xs, "correctFields"), sum(xs, "expectedFields"));
  const group = (key: (x: SampleScore) => string) => {
    const m: Record<string, SampleScore[]> = {};
    for (const x of samples) (m[key(x)] ??= []).push(x);
    return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Math.round(acc(v) * 1000) / 1000]));
  };
  return {
    samples,
    exactness: ratio(sum(samples, "confirmedExact"), sum(samples, "confirmedFacts")),
    printed: acc(samples.filter((x) => !x.handwritten)),
    handwritten: acc(samples.filter((x) => x.handwritten)),
    precision: ratio(sum(samples, "correctExtractedFields"), sum(samples, "extractedFields")),
    calibration: ratio(sum(samples, "wrongFactsLow"), sum(samples, "wrongFacts")),
    translatedPages: sum(samples, "translatedPages"), translationFailures: sum(samples, "translationFailures"),
    byLanguage: group((x) => x.language), byCategory: group((x) => x.category),
    languages: [...new Set(samples.map((x) => x.language))].sort(), handwrittenSamples: samples.filter((x) => x.handwritten).length,
  };
}

export function meetsTargets(r: EvalReport): { ok: boolean; misses: string[] } {
  const misses: string[] = [];
  if (r.exactness < TARGETS.exactness) misses.push(`exactness ${r.exactness} < ${TARGETS.exactness}`);
  if (r.printed < TARGETS.printed) misses.push(`printed field accuracy ${r.printed.toFixed(3)} < ${TARGETS.printed}`);
  if (r.handwritten < TARGETS.handwritten) misses.push(`handwritten field accuracy ${r.handwritten.toFixed(3)} < ${TARGETS.handwritten}`);
  return { ok: misses.length === 0, misses };
}

export function reportMarkdown(r: EvalReport, provider: string): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const lines = [
    `# Document pipeline evaluation (${provider})`, "",
    `- Samples: ${r.samples.length} (${r.handwrittenSamples} handwritten-style), languages: ${r.languages.join(", ")}`,
    `- Exactness of confirmed facts: **${pct(r.exactness)}** (target 100%)`,
    `- Field accuracy, printed: **${pct(r.printed)}** (target ≥ 90%)`,
    `- Field accuracy, handwritten: **${pct(r.handwritten)}** (target ≥ 75%)`,
    `- Field precision: ${pct(r.precision)}`,
    `- Wrong facts flagged LOW: ${pct(r.calibration)}`,
    `- Translations: ${r.translatedPages} passed, ${r.translationFailures} failed the exact-copy check (never shown)`, "",
    "| Language | Field accuracy |", "|---|---|", ...Object.entries(r.byLanguage).map(([k, v]) => `| ${k} | ${pct(v)} |`), "",
    "| Category | Field accuracy |", "|---|---|", ...Object.entries(r.byCategory).map(([k, v]) => `| ${k} | ${pct(v)} |`), "",
    "| Sample | Lang | Handwritten | Fields right | Confirmed | Wrong (LOW) |", "|---|---|---|---|---|---|",
    ...r.samples.map((x) => `| ${x.id} | ${x.language} | ${x.handwritten ? "yes" : ""} | ${x.correctFields}/${x.expectedFields} | ${x.confirmedFacts} | ${x.wrongFacts} (${x.wrongFactsLow}) |`),
  ];
  return lines.join("\n");
}

export { ocrLines };
