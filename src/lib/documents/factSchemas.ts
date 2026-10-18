import { z } from "zod";
import type { ExtractedFactType, PatientProvidedKind } from "@prisma/client";

/**
 * Week 4a — the value of each fact type (docs/DOCUMENT_PIPELINE_DESIGN.md
 * §2.5). Strict: an unknown field is refused. Fields marked exact hold the
 * original text verbatim (§5.3): they must occur in the fact's sourceText,
 * which must occur in the page's OCR text, and a model may never reformat them.
 */
const text = z.string().trim().min(1).max(500);
const opt = text.optional();

export const DOCUMENT_TYPES = ["PRESCRIPTION", "LAB_REPORT", "IMAGING_REPORT", "DISCHARGE_SUMMARY", "CONSULTATION_NOTE", "OTHER"] as const;
export const FREQUENCY_CODES = ["OD", "BD", "TDS", "QID", "HS", "SOS", "STAT", "WEEKLY", "OTHER"] as const;

export const FACT_VALUE_SCHEMAS = {
  DOCUMENT_META: z.object({ documentType: z.enum(DOCUMENT_TYPES), documentDate: opt, doctorName: opt, registrationNo: opt, facilityName: opt }).strict(),
  DIAGNOSIS: z.object({ text, icd10: z.string().regex(/^[A-Z]\d{2}(\.\d{1,2})?$/).optional(), status: z.enum(["ACTIVE", "RESOLVED", "HISTORY"]).optional(), onsetDate: opt }).strict(),
  MEDICATION: z.object({
    name: text, strength: opt, form: opt, dose: opt, route: opt, frequency: opt,
    frequencyCode: z.enum(FREQUENCY_CODES).optional(), duration: opt, instructions: opt,
  }).strict(),
  LAB_VALUE: z.object({
    analyte: text, value: text, numericValue: z.number().finite().optional(), unit: opt, referenceRange: opt,
    flag: z.enum(["H", "L", "N"]).optional(), specimenDate: opt,
  }).strict(),
  PROCEDURE: z.object({ text, date: opt, facilityName: opt }).strict(),
  ALLERGY: z.object({ substance: text, reaction: opt, severity: opt }).strict(),
} as const satisfies Record<ExtractedFactType, z.ZodTypeAny>;

export type FactValue<T extends ExtractedFactType> = z.infer<(typeof FACT_VALUE_SCHEMAS)[T]>;

/** The exact fields of each type (§2.5): verbatim from the source, never reformatted. */
export const EXACT_FIELDS: Record<ExtractedFactType, readonly string[]> = {
  DOCUMENT_META: [],
  DIAGNOSIS: ["text"],
  MEDICATION: ["name", "strength", "dose", "frequency"],
  LAB_VALUE: ["analyte", "value", "unit", "referenceRange"],
  PROCEDURE: ["text"],
  ALLERGY: ["substance"],
};

/**
 * The fields whose absence makes a fact incomplete (§7: one band lower). They
 * are optional in the schema so an incomplete fact reaches the person, flagged,
 * to correct or reject, rather than being silently dropped.
 */
export const COMPLETENESS_FIELDS: Partial<Record<ExtractedFactType, readonly string[]>> = {
  MEDICATION: ["dose", "frequency"],
  LAB_VALUE: ["unit"],
};

/** Which record kind a confirmed fact becomes (§3). DOCUMENT_META never becomes an entry. */
export const RECORD_KIND: Record<ExtractedFactType, PatientProvidedKind | null> = {
  DOCUMENT_META: null,
  DIAGNOSIS: "DIAGNOSIS",
  MEDICATION: "MEDICATION_HISTORY",
  LAB_VALUE: "LAB_RESULT",
  PROCEDURE: "PROCEDURE",
  ALLERGY: "ALLERGY",
};

export function parseFactValue(factType: ExtractedFactType, value: unknown) {
  return FACT_VALUE_SCHEMAS[factType].safeParse(value);
}

/** The value's fields present (for per-field confirmation of handwritten facts). */
export function factFields(value: Record<string, unknown>): string[] {
  return Object.keys(value).filter((k) => value[k] !== undefined && value[k] !== null).sort();
}
