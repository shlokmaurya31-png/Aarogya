/**
 * Machine-checkable statement of what an educational case is allowed to
 * contain, used by caseSanitizer.ts as an assertion pass and by tests as a
 * regression guard. This is a development safety net, not a compliance
 * certification — see docs/CLINICAL_EDUCATION_PRIVACY.md for the honest
 * framing (no DPDP/NDHM/ABDM certification claims are made anywhere).
 */

const FORBIDDEN_FIELD_NAMES = [
  "patientId",
  "aadhaar",
  "aadhaarNumber",
  "abhaNumber",
  "phone",
  "phoneNumber",
  "email",
  "address",
  "insuranceId",
  "policyNumber",
  "photograph",
  "photoUrl",
  "dicomId",
  "staffNotes",
  "recordNumber",
  "facilityName",
  "roomBed",
  "exactAdmissionTimestamp",
];

export interface PolicyViolation {
  path: string;
  reason: string;
}

/** Recursively scans an educational case object for field names that must never appear. */
export function checkNoProhibitedIdentifiers(value: unknown, path = "$"): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  if (value === null || typeof value !== "object") return violations;

  if (Array.isArray(value)) {
    value.forEach((item, i) => violations.push(...checkNoProhibitedIdentifiers(item, `${path}[${i}]`)));
    return violations;
  }

  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_FIELD_NAMES.includes(key)) {
      violations.push({ path: `${path}.${key}`, reason: `Field name "${key}" is a prohibited identifier field.` });
    }
    violations.push(...checkNoProhibitedIdentifiers(val, `${path}.${key}`));
  }
  return violations;
}
