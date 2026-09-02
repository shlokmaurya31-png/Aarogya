/**
 * De-identification of a hypothetical raw clinical-source record into the
 * shape the Clinical Learning Data Gateway is willing to pass downstream.
 * There is no code path in this repository that calls this with real data —
 * SyntheticCaseProvider never routes through it because synthetic cases are
 * already free of source identifiers. This module exists so the pipeline
 * shape is real and testable (see src/lib/privacy/__tests__) before it is
 * ever pointed at anything sensitive, per docs/CLINICAL_EDUCATION_PRIVACY.md.
 */
import { redactFreeText } from "./redaction";
import { ageToBand } from "./educationalIdentity";

/** Fields a hypothetical raw clinical source record might carry. Intentionally broad. */
export interface RawClinicalRecord {
  patientName: string;
  patientId: string;
  aadhaar?: string;
  abhaNumber?: string;
  phone?: string;
  email?: string;
  address?: string;
  exactAge: number;
  sex: string;
  admissionDateIso: string;
  facilityName: string;
  roomBed?: string;
  clinicianNotes: string;
  rareDiseaseFlag?: boolean;
}

export interface DeidentifiedRecord {
  ageBand: string;
  exactAgeIfClinicallyRequired?: number;
  sex: string;
  sanitizedNotes: string;
  facilityGeneralized: string; // e.g. "Tertiary care hospital, Western India" — never the real name
  strongerPrivacyControls: boolean; // true for rare-disease cases, per policy
  identifiersRemoved: string[];
}

const DIRECT_IDENTIFIER_FIELDS = [
  "patientName",
  "patientId",
  "aadhaar",
  "abhaNumber",
  "phone",
  "email",
  "address",
  "facilityName",
  "roomBed",
] as const;

export function deidentifyRecord(
  raw: RawClinicalRecord,
  opts: { requireExactAge?: boolean } = {}
): DeidentifiedRecord {
  const { redactedCount: _redactedCount, text: sanitizedNotes } = redactFreeText(raw.clinicianNotes);
  void _redactedCount;

  const identifiersRemoved = DIRECT_IDENTIFIER_FIELDS.filter((f) => Boolean(raw[f]));

  return {
    ageBand: ageToBand(raw.exactAge),
    exactAgeIfClinicallyRequired: opts.requireExactAge ? raw.exactAge : undefined,
    sex: raw.sex,
    sanitizedNotes,
    facilityGeneralized: "Tertiary care teaching hospital, India",
    strongerPrivacyControls: Boolean(raw.rareDiseaseFlag),
    identifiersRemoved,
  };
}
