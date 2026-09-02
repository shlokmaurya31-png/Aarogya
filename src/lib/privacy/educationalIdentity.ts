/**
 * Generates an independent educational identity for a case. This name has
 * NO relationship to any real source patient's name — it is deterministically
 * derived from the case id purely so the same case always shows the same
 * educational name across renders/sessions, not because it encodes anything
 * about a real person. There is no function anywhere in this codebase that
 * maps an educational identity back to a source identity; see
 * docs/STUDENT_PLATFORM_ARCHITECTURE.md §2.5 and
 * docs/CLINICAL_EDUCATION_PRIVACY.md "Principle: Student Case ID != Clinical
 * Patient ID" for why that mapping, if it must exist at all, cannot live in
 * this application.
 */
import { createHash } from "crypto";

const FIRST_NAMES_MALE = [
  "Aarav", "Vihaan", "Arjun", "Rohan", "Karthik", "Aditya", "Rahul", "Sanjay",
  "Imran", "Farhan", "Manoj", "Suresh", "Vikram", "Ravi", "Anand", "Deepak",
];
const FIRST_NAMES_FEMALE = [
  "Ananya", "Priya", "Diya", "Neha", "Kavya", "Isha", "Meera", "Sunita",
  "Fatima", "Aisha", "Lakshmi", "Radha", "Pooja", "Sneha", "Divya", "Anjali",
];
const FIRST_NAMES_OTHER = ["Riya", "Rey", "Kiran", "Alex", "Sam", "Nila"];
const LAST_NAMES = [
  "Mehta", "Sharma", "Reddy", "Nair", "Iyer", "Khan", "Patel", "Gupta",
  "Rao", "Verma", "Joshi", "Kumar", "Das", "Bhat", "Chatterjee", "Pillai",
];

function seedFromString(input: string): number {
  const hash = createHash("sha256").update(input).digest();
  return hash.readUInt32BE(0);
}

export type EducationalSex = "male" | "female" | "intersex-unspecified";

export function generateEducationalIdentity(caseId: string, sex: EducationalSex): { name: string } {
  const seed = seedFromString(caseId);
  const pool = sex === "male" ? FIRST_NAMES_MALE : sex === "female" ? FIRST_NAMES_FEMALE : FIRST_NAMES_OTHER;
  const first = pool[seed % pool.length];
  const last = LAST_NAMES[Math.floor(seed / pool.length) % LAST_NAMES.length];
  return { name: `${first} ${last}` };
}

/**
 * Generalizes an exact age into a clinically meaningful band, unless the
 * case genuinely requires an exact age for a calculation (e.g. pediatric
 * weight-based dosing) — callers pass `requireExact` for those cases only.
 */
export function ageToBand(age: number): string {
  const lower = Math.floor(age / 5) * 5;
  return `${lower}-${lower + 4}`;
}

export function generateCaseSlug(specialtyCode: string, index: number): string {
  return `EDU-${specialtyCode.toUpperCase()}-${String(index).padStart(3, "0")}`;
}
