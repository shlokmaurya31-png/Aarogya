import type { ExtractedFactType } from "@prisma/client";
import type { DOCUMENT_TYPES } from "../factSchemas";
import type { SupportedLanguage } from "../vocab";

export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export interface FixtureLine { text: string; confidence?: number }
/** A ground-truth fact: what the document says. `sourceText` is the printed line. */
export interface ExpectedFact { factType: ExtractedFactType; value: Record<string, unknown>; sourceText?: string }

export interface DocumentFixture {
  id: string;
  category: "LAB_REPORT" | "PRESCRIPTION" | "HANDWRITTEN_PRESCRIPTION" | "DISCHARGE_SUMMARY" | "IMAGING_REPORT" | "MIXED";
  language: SupportedLanguage;
  script: string;
  mixed: boolean;
  handwritten: boolean;
  targetLanguage: SupportedLanguage;
  pages: { lines: FixtureLine[] }[];
  expected: ExpectedFact[];
  /** Handwritten-style OCR misreads (printed substring → what OCR reads). */
  misreads: Record<string, string>;
  /** Brand names the mock tagger tags (model tagging stands in for a brand list). */
  brands: string[];
  /** The synthetic patient name printed on the report (an identifier: never sent to a provider). */
  patientName: string;
}
