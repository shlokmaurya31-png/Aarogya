/**
 * Single choke point: every case that leaves the Clinical Learning Data
 * Gateway (src/lib/clinical/gateway.ts) passes through here on its way to
 * becoming a persisted ClinicalCase. Any future real-data provider MUST call
 * this — the gateway enforces that structurally by only accepting
 * EducationalCaseSnapshot values that were produced by this function.
 */
import { generateEducationalIdentity, ageToBand, type EducationalSex } from "./educationalIdentity";
import { deidentifyRecord, type RawClinicalRecord } from "./deidentify";
import { checkNoProhibitedIdentifiers } from "./privacyPolicy";

export interface EducationalCaseSnapshot {
  caseId: string;
  patientName: string;
  ageBand: string;
  exactAge?: number;
  sex: string;
  sanitizedNotes: string;
  strongerPrivacyControls: boolean;
}

/**
 * Sanitizes a raw source record into an EducationalCaseSnapshot. Throws if
 * the result still contains a prohibited identifier field name — a defensive
 * check, since deidentifyRecord() already strips these.
 */
export function sanitizeToEducationalCase(
  caseId: string,
  raw: RawClinicalRecord,
  sex: EducationalSex,
  opts: { requireExactAge?: boolean } = {}
): EducationalCaseSnapshot {
  const deidentified = deidentifyRecord(raw, opts);
  const identity = generateEducationalIdentity(caseId, sex);

  const snapshot: EducationalCaseSnapshot = {
    caseId,
    patientName: identity.name,
    ageBand: deidentified.ageBand,
    exactAge: deidentified.exactAgeIfClinicallyRequired,
    sex: deidentified.sex,
    sanitizedNotes: deidentified.sanitizedNotes,
    strongerPrivacyControls: deidentified.strongerPrivacyControls,
  };

  const violations = checkNoProhibitedIdentifiers(snapshot);
  if (violations.length > 0) {
    throw new Error(
      `Refusing to produce educational case: prohibited identifiers survived sanitization: ${JSON.stringify(violations)}`
    );
  }

  return snapshot;
}

/** Synthetic cases are authored directly in educational form and never touch raw source data, but still pass the same policy check before being seeded. */
export function assertSyntheticCaseIsClean(caseContent: unknown): void {
  const violations = checkNoProhibitedIdentifiers(caseContent);
  if (violations.length > 0) {
    throw new Error(`Synthetic case failed privacy policy check: ${JSON.stringify(violations)}`);
  }
}

export { ageToBand };
