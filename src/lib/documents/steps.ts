import { PDFDocument } from "pdf-lib";
import type { DocumentStepError } from "@prisma/client";
import type { DocumentProviders, ProcessingPermit } from "@/lib/ai/documents/types";
import { INN_STARTER } from "@/lib/medicines/innStarter";
import { nlemNames } from "@/lib/medicines/reference";
import { mask, noInventedNumbers, placeholdersIntact, protectedSpans, restore, type Masked, type Span } from "./protect";
import { identifierSpans } from "./identifiers";

/**
 * Week 4a — the pipeline's pure steps, shared by the consumers
 * (pipeline.ts) and the evaluation (eval.ts): no database, no storage.
 */

export const MAX_PAGES = 50;

/** One single-page PDF per page; the original bytes are only read. */
export async function splitPdf(bytes: Buffer): Promise<Buffer[] | DocumentStepError> {
  let src: PDFDocument;
  try { src = await PDFDocument.load(bytes, { updateMetadata: false }); } catch { return "UNREADABLE"; }
  const n = src.getPageCount();
  if (n === 0) return "UNREADABLE";
  if (n > MAX_PAGES) return "TOO_LARGE";
  const out: Buffer[] = [];
  for (let i = 0; i < n; i++) {
    const one = await PDFDocument.create({ updateMetadata: false });
    const [p] = await one.copyPages(src, [i]);
    one.addPage(p);
    out.push(Buffer.from(await one.save({ useObjectStreams: false })));
  }
  return out;
}

/** The text with protected values blanked (for language detection: values are printed in English everywhere). */
export function stripProtected(text: string, dictionary: readonly string[]): string {
  let out = "", at = 0;
  for (const s of protectedSpans(text, dictionary)) { out += text.slice(at, s.start) + " "; at = s.end; }
  return out + text.slice(at);
}

/** NLEM 2022 and the curated INN starter set, without a database (the evaluation's dictionary). */
export function evaluationDictionary(): string[] {
  return [...new Set([...nlemNames(), ...INN_STARTER])];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Translation with the exact-copy check (§5.2): protected values and the
 * person's identifiers become placeholders before the tagger and the
 * translator see the text; the placeholder multiset must come back exactly and
 * no digit may be invented; one strict retry; a translation still failing is
 * FAILED and keeps only the translator's raw placeholder output.
 */
export async function translateText(text: string, from: string, to: string, dictionary: readonly string[], identifiers: readonly string[], providers: Pick<DocumentProviders, "translation" | "tagging">, permit: ProcessingPermit): Promise<{ text: string; check: "PASSED" | "FAILED"; spans: Masked; model: string }> {
  const idSpans = identifierSpans(text, identifiers);
  // Tagging sees the text with identifiers (and values) already masked.
  const forTagging = mask(text, protectedSpans(text, [], idSpans)).masked;
  const tagged = (await providers.tagging.tagMedicines(forTagging, permit)).names;
  const extra: Span[] = [...idSpans];
  for (const name of tagged) for (const m of text.matchAll(new RegExp(escapeRe(name), "gu"))) extra.push({ start: m.index!, end: m.index! + m[0].length, kind: "TAGGED" });
  const m = mask(text, protectedSpans(text, dictionary, extra));
  let last = { text: "", model: "" };
  for (const strict of [false, true]) {
    last = await providers.translation.translate(m.masked, from, to, { strict }, permit);
    if (placeholdersIntact(last.text, m.originals.length) && noInventedNumbers(last.text)) {
      return { text: restore(last.text, m.originals), check: "PASSED", spans: m, model: last.model };
    }
  }
  return { text: last.text, check: "FAILED", spans: m, model: last.model };
}
