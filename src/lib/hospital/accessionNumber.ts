import { dayKey, DEFAULT_TIME_ZONE } from "@/lib/time/zone";
/**
 * Shared accession-number generator (brief §11 lab / §7 radiology) — a
 * simple date+random scheme, explicitly a placeholder ("design for future
 * configurable accession numbering") rather than a real sequence/checksum
 * scheme. The caller's own `@@unique([facilityId, accessionNumber])`
 * constraint is the real safety net; a collision just fails the
 * transaction rather than silently duplicating a number.
 */
export function generateAccessionNumber(prefix: string): string {
  // India's date, whatever zone the server runs in (Flagship 2a); a label only.
  const datePart = dayKey(new Date(), DEFAULT_TIME_ZONE).replace(/-/g, "");
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}-${datePart}-${rand}`;
}
