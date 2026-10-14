/**
 * Patient age is always calculated from the date of birth (never stored).
 * Client-safe: no server imports. `dob` may be a Date or an ISO string (JSON).
 */
export type DobLike = Date | string | null | undefined;

/** Whole years between dob and `now`, or null without a dob. */
export function ageInYears(dob: DobLike, now: Date = new Date()): number | null {
  if (!dob) return null;
  const d = typeof dob === "string" ? new Date(dob) : dob;
  if (Number.isNaN(d.getTime())) return null;
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age -= 1;
  return Math.max(age, 0);
}

/** "34", "~34" when the dob is an estimate, or "?" when unknown. */
export function ageLabel(p: { dob?: DobLike; dobEstimated?: boolean | null }, now: Date = new Date()): string {
  const age = ageInYears(p.dob, now);
  if (age === null) return "?";
  return `${p.dobEstimated ? "~" : ""}${age}`;
}

/** An estimated dob for an age given at registration: today's day and month, `age` years ago. */
export function estimatedDobFromAge(age: number, now: Date = new Date()): Date {
  const d = new Date(Date.UTC(now.getFullYear() - age, now.getMonth(), now.getDate()));
  return d;
}
