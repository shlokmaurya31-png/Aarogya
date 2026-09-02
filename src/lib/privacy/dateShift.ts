/**
 * Per-case consistent date shifting: every date belonging to the same source
 * case is shifted by the same random offset, so relative intervals (symptom
 * onset -> admission -> discharge) are preserved for teaching purposes while
 * the real calendar date is hidden. The offset is derived from the case's
 * own id (deterministic per case, not reversible to a real record without
 * already holding the id -> offset mapping, which the education platform
 * never stores — see docs/CLINICAL_EDUCATION_PRIVACY.md §3).
 */
import { createHash } from "crypto";

const MAX_SHIFT_DAYS = 400;

export function shiftOffsetDaysForCase(caseSourceId: string): number {
  const hash = createHash("sha256").update(caseSourceId).digest();
  const seed = hash.readUInt32BE(0);
  // Deterministic pseudo-random offset in [-MAX_SHIFT_DAYS, MAX_SHIFT_DAYS], excluding 0.
  const magnitude = (seed % MAX_SHIFT_DAYS) + 1;
  const sign = seed % 2 === 0 ? 1 : -1;
  return magnitude * sign;
}

export function shiftDate(isoDate: string, offsetDays: number): string {
  const date = new Date(isoDate);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

/** Shifts every date in an object shape by the same case-level offset, preserving intervals. */
export function shiftDatesConsistently<T extends Record<string, unknown>>(
  record: T,
  dateKeys: (keyof T)[],
  caseSourceId: string
): T {
  const offset = shiftOffsetDaysForCase(caseSourceId);
  const shifted = { ...record };
  for (const key of dateKeys) {
    const value = record[key];
    if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
      (shifted as Record<string, unknown>)[key as string] = shiftDate(value, offset);
    }
  }
  return shifted;
}
