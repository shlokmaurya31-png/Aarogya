import type { DocumentStepError, ExtractedFactType } from "@prisma/client";

/**
 * Week 4a — the document pipeline's provider boundary
 * (docs/DOCUMENT_PIPELINE_DESIGN.md §6; ADR 0003). Each provider has a
 * deterministic mock (CI never needs a key) and a Claude implementation.
 *
 * Every call takes a ProcessingPermit, which only mayProcessPersonData()
 * issues: a provider can't be called for a Person the real-data switch or
 * consent refuses, even by mistake.
 */

/** A line of OCR output: its text, a normalized box [x, y, w, h] in 0..1, and its confidence. */
export interface Line { text: string; bbox: [number, number, number, number]; confidence: number; language?: string }

export interface OcrResult { text: string; layout: Line[]; language: string; script: string; handwritten: boolean; confidence: number; model: string }

/** A fact as an extractor proposes it; confidence and exact-copy checks are computed by the pipeline (§5.3, §7). */
export interface CandidateFact {
  factType: ExtractedFactType;
  value: Record<string, unknown>;
  /** The exact span of the page text the fact came from. */
  sourceText: string;
  /** Indexes into the page layout of the lines it came from. */
  lines: number[];
}

declare const permitBrand: unique symbol;
export interface ProcessingPermit { readonly personId: string; readonly purpose: "DOCUMENT_PROCESSING"; readonly [permitBrand]: true }

export interface VisionOcrProvider {
  readonly id: "claude" | "mock";
  ocrPage(page: { bytes: Buffer; contentType: string }, hints: { languages?: string[]; retry?: boolean }, permit: ProcessingPermit): Promise<OcrResult>;
}
export interface TranslationProvider {
  readonly id: "claude" | "mock";
  /** `text` contains ⟦Pn⟧ placeholders that must come back unchanged. */
  translate(text: string, from: string, to: string, opts: { strict?: boolean }, permit: ProcessingPermit): Promise<{ text: string; model: string }>;
}
export interface FactExtractor {
  readonly id: "claude" | "mock";
  /** `pass: 2`: a second, differently worded pass (handwritten pages); disagreement forces LOW. */
  extract(page: { text: string; layout: Line[]; language: string }, permit: ProcessingPermit, opts?: { pass?: 2 }): Promise<{ facts: CandidateFact[]; model: string }>;
}
export interface MedicineTagger {
  readonly id: "claude" | "mock";
  /** Exact substrings of `text` that name a medicine; only ever adds protection. */
  tagMedicines(text: string, permit: ProcessingPermit): Promise<{ names: string[]; model: string }>;
}

export interface DocumentProviders { ocr: VisionOcrProvider; translation: TranslationProvider; extraction: FactExtractor; tagging: MedicineTagger }

/** A provider failure with a closed code; never carries provider text. */
export class DocumentProviderError extends Error {
  constructor(readonly code: DocumentStepError) {
    super(`Document provider error: ${code}`);
    this.name = "DocumentProviderError";
  }
}
