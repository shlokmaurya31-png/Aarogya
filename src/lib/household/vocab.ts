/**
 * Week 5b — households' fixed values (docs/HOUSEHOLD_DESIGN.md, the 5b decisions).
 */
/** Members per household (5b decision: 8), the manager's own profile included. */
export const MAX_MEMBERS = 8;
/** Guardians don't see sensitive categories from this age (5b decision, pending lawyer review). */
export const ADOLESCENT_FROM = 12;
export const ADULT_AT = 18;
/** Managers are told this many days before a member comes of age. */
export const COMING_OF_AGE_NOTICE_DAYS = 30;
/** One-time codes (parental consent, a dependent adult's own confirmation, a claim). */
export const CODE_TTL_MINUTES = 30;

/** What a manager declares about a minor they add (parental consent, pending lawyer review). */
export const GUARDIAN_RELATIONSHIPS = ["MOTHER", "FATHER", "LEGAL_GUARDIAN"] as const;
/** What a manager declares about a dependent adult. */
export const ADULT_RELATIONSHIPS = ["SPOUSE", "PARENT", "CHILD", "SIBLING", "OTHER_RELATIVE", "CAREGIVER"] as const;
/** A legal document a staff member can review for a dependent adult's proxy. */
export const LEGAL_DOCUMENT_KINDS = ["POWER_OF_ATTORNEY", "GUARDIANSHIP_ORDER", "OTHER_COURT_ORDER"] as const;

/** The parental-consent declaration the manager confirms (pending lawyer review). */
export const PARENTAL_DECLARATION =
  "I declare that I am this child's parent or legal guardian, that I may consent on their behalf to keeping their health record in Aarogya, and that what I have entered is true. I understand that a false declaration may be reported.";

/** Whole years between a date of birth and `at` (UTC calendar). */
export function ageOn(dob: Date, at: Date): number {
  let age = at.getUTCFullYear() - dob.getUTCFullYear();
  const m = at.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && at.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}

/**
 * When a managed minor comes of age: the 18th birthday for a DAY-precision
 * date; for a coarser one (YEAR, or estimated), 1 January of the year after
 * the 18th birthday's year (decision 9).
 */
export function comingOfAge(dob: Date, precision: string | null | undefined): Date {
  if (precision === "DAY" || precision === null || precision === undefined) {
    const d = new Date(dob);
    d.setUTCFullYear(d.getUTCFullYear() + ADULT_AT);
    return d;
  }
  return new Date(Date.UTC(dob.getUTCFullYear() + ADULT_AT + 1, 0, 1));
}
