import type { LabReferenceRange, AbnormalFlag } from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * Picks the applicable reference range for a patient (brief §9). Ranges are
 * configuration data (LabReferenceRange), never hardcoded — every caller
 * goes through this function rather than embedding a threshold in a
 * component. Returns null when no configured range applies, in which case
 * no abnormal flag is computed (silence, not a guessed range).
 */
export async function findApplicableReferenceRange(
  catalogTestId: string,
  patientSex: string | null | undefined,
  patientAgeYears: number | null | undefined
): Promise<LabReferenceRange | null> {
  const ranges = await prisma.labReferenceRange.findMany({
    where: { catalogTestId, effectiveTo: null },
  });
  const now = new Date();
  const matching = ranges.filter((r) => {
    if (r.effectiveFrom > now) return false;
    if (r.sex && patientSex && r.sex.toLowerCase() !== patientSex.toLowerCase()) return false;
    if (r.minAgeYears != null && (patientAgeYears == null || patientAgeYears < r.minAgeYears)) return false;
    if (r.maxAgeYears != null && (patientAgeYears == null || patientAgeYears > r.maxAgeYears)) return false;
    return true;
  });
  // Most specific match first — a sex/age-scoped range beats a generic one.
  matching.sort((a, b) => Number(b.sex != null || b.minAgeYears != null) - Number(a.sex != null || a.minAgeYears != null));
  return matching[0] ?? null;
}

/** Pure function — computes an abnormal flag from a numeric value + configured range. Never invents a range itself. */
export function computeAbnormalFlag(numericValue: number, range: LabReferenceRange | null): AbnormalFlag | null {
  if (!range) return null;
  if (range.criticalLow != null && numericValue < range.criticalLow) return "CRITICAL_LOW";
  if (range.criticalHigh != null && numericValue > range.criticalHigh) return "CRITICAL_HIGH";
  if (range.low != null && numericValue < range.low) return "LOW";
  if (range.high != null && numericValue > range.high) return "HIGH";
  return "NORMAL";
}
