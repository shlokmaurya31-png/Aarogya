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
  /** Wall time for the sample (all its provider calls). */
  ms: number;
  /** A provider error that stopped the sample (its expected fields all count as missed). */
  error?: string;
}

const DATE_FIELDS = new Set(["documentDate", "specimenDate", "onsetDate", "date"]);
/** dd/mm/yyyy (the Indian convention, as printed) or ISO yyyy-mm-dd → yyyy-mm-dd; anything else as is. */
function isoDate(v: unknown): string {
  const t = String(v ?? "").trim();
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  return ymd ? `${ymd[1]}-${ymd[2]}-${ymd[3]}` : t;
}

/**
 * One field, extracted vs expected. Exact fields (§5.3) must be identical,
 * byte for byte. The rest are compared for meaning: a date as a date, a
 * number as a number, a code ignoring case and surrounding space.
 */
export function sameField(type: ExtractedFactType, key: string, got: unknown, want: unknown): boolean {
  if ((EXACT_FIELDS[type] as readonly string[]).includes(key)) return canon(got) === canon(want);
  if (got === undefined || want === undefined) return got === want;
  if (DATE_FIELDS.has(key)) return isoDate(got) === isoDate(want);
  if (key === "numericValue") return Number(got) === Number(want);
  return String(got).trim().toLowerCase() === String(want).trim().toLowerCase();
}

const tokens = (t: string) => new Set(t.normalize("NFKC").toLowerCase().split(/\s+/u).filter(Boolean));
function overlap(a: string, b: string): number {
  const x = tokens(a), y = tokens(b);
  let n = 0;
  for (const w of x) if (y.has(w)) n += 1;
  return x.size + y.size === 0 ? 0 : n / (x.size + y.size - n);
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

const emptyScore = (f: DocumentFixture): SampleScore => ({ id: f.id, language: f.language, handwritten: f.handwritten, category: f.category, expectedFields: 0, correctFields: 0, extractedFields: 0, correctExtractedFields: 0, confirmedFacts: 0, confirmedExact: 0, confirmedExactFields: 0, wrongFacts: 0, wrongFactsLow: 0, translatedPages: 0, translationFailures: 0, dropped: 0, facts: 0, ms: 0 });

export async function scoreSample(f: DocumentFixture, providers: DocumentProviders, permit: ProcessingPermit, dictionary: readonly string[], input: EvalInput = "marker-pdf"): Promise<SampleScore> {
  const started = Date.now();
  const pages = await samplePages(f, input, providers);
  const s = emptyScore(f);
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

  // Match each expected fact to the extracted fact read from its (OCR'd) line;
  // failing an exact match (a real model may span the line differently), the
  // unmatched fact of that type whose source shares the most words (≥ half).
  const byKey = new Map<string, AssessedFact>();
  for (const a of assessed) byKey.set(a.factType === "DOCUMENT_META" ? matchKey(a.factType, "") : matchKey(a.factType, a.sourceText), a);
  const expectedOf = new Map<AssessedFact, ExpectedFact>();
  const unmatched: ExpectedFact[] = [];
  for (const e of f.expected) {
    const a = byKey.get(e.factType === "DOCUMENT_META" ? matchKey(e.factType, "") : matchKey(e.factType, misread(f, e.sourceText!)));
    if (a && !expectedOf.has(a)) expectedOf.set(a, e);
    else unmatched.push(e);
  }
  for (const e of unmatched) {
    const want = misread(f, e.sourceText ?? "");
    const best = assessed.filter((a) => a.factType === e.factType && !expectedOf.has(a)).map((a) => ({ a, o: overlap(a.sourceText, want) })).sort((x, y) => y.o - x.o)[0];
    if (best && best.o >= 0.5) expectedOf.set(best.a, e);
  }
  for (const e of f.expected) {
    const fields = factFields(e.value);
    s.expectedFields += fields.length;
    const a = [...expectedOf].find(([, x]) => x === e)?.[0];
    if (a) s.correctFields += fields.filter((k) => sameField(e.factType, k, a.value[k], e.value[k])).length;
  }
  for (const a of assessed) {
    const e = expectedOf.get(a);
    const fields = factFields(a.value);
    s.extractedFields += fields.length;
    const right = !!e && factFields(e.value).every((k) => sameField(e.factType, k, a.value[k], e.value[k]));
    if (e) s.correctExtractedFields += fields.filter((k) => sameField(e.factType, k, a.value[k], e.value[k])).length;
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
  s.ms = Date.now() - started;
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

export interface EvalRunOptions {
  /** Samples scored at once (the real run; provider rate limits permitting). */
  concurrency?: number;
  /** Score a sample whose provider call failed as all-missed, and go on (the real run). */
  continueOnError?: boolean;
  onSample?: (s: SampleScore) => void;
}

export async function runEvaluation(providers: DocumentProviders, permit: ProcessingPermit, dictionary: readonly string[], fixtures: readonly DocumentFixture[] = FIXTURES, input: EvalInput = "marker-pdf", opts: EvalRunOptions = {}): Promise<EvalReport> {
  const samples: SampleScore[] = new Array(fixtures.length);
  let next = 0;
  const worker = async () => {
    while (next < fixtures.length) {
      const i = next++;
      const f = fixtures[i];
      try {
        samples[i] = await scoreSample(f, providers, permit, dictionary, input);
      } catch (err) {
        if (!opts.continueOnError) throw err;
        const s = emptyScore(f);
        s.expectedFields = f.expected.reduce((n, e) => n + factFields(e.value).length, 0);
        s.error = (err as { code?: string }).code ?? "INTERNAL";
        samples[i] = s;
      }
      opts.onSample?.(samples[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 1) }, worker));
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

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const v = [...xs].sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
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
    `- Translations: ${r.translatedPages} passed, ${r.translationFailures} failed the exact-copy check (never shown)`,
    `- Latency per sample: median ${median(r.samples.map((x) => x.ms))} ms, max ${Math.max(0, ...r.samples.map((x) => x.ms))} ms`,
    `- Samples stopped by a provider error: ${r.samples.filter((x) => x.error).length}${r.samples.some((x) => x.error) ? ` (${r.samples.filter((x) => x.error).map((x) => `${x.id}: ${x.error}`).join(", ")})` : ""}`, "",
    "| Language | Field accuracy |", "|---|---|", ...Object.entries(r.byLanguage).map(([k, v]) => `| ${k} | ${pct(v)} |`), "",
    "| Category | Field accuracy |", "|---|---|", ...Object.entries(r.byCategory).map(([k, v]) => `| ${k} | ${pct(v)} |`), "",
    "| Sample | Lang | Handwritten | Fields right | Confirmed | Wrong (LOW) | ms |", "|---|---|---|---|---|---|---|",
    ...r.samples.map((x) => `| ${x.id} | ${x.language} | ${x.handwritten ? "yes" : ""} | ${x.correctFields}/${x.expectedFields} | ${x.confirmedFacts} | ${x.wrongFacts} (${x.wrongFactsLow}) | ${x.error ? `error ${x.error}` : x.ms} |`),
  ];
  return lines.join("\n");
}

export { ocrLines };
