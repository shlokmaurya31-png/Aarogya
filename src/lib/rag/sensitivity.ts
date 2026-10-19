import type { RagSensitiveCategory } from "@prisma/client";

/**
 * Week 4b — the sensitive-category mapping (docs/RAG_DESIGN.md §3.1, §5.3).
 * PLACEHOLDER LIST, PENDING CLINICAL ADVISOR (pre-launch item 2a). It errs
 * towards marking: a false positive hides an entry until the patient opts the
 * category in; a false negative would show it. A sensitive entry is never a
 * retrieval candidate unless that category was opted in for the access path.
 *
 *   by ICD-10 code   F10–F19 substance use; F (other) mental health; B20–B24,
 *                    Z21 HIV; A50–A64 sexual health; O, Z30–Z39 reproductive
 *   by words         in a diagnosis, test name, note type or text (below)
 */
const CODE_RULES: [RegExp, RagSensitiveCategory][] = [
  [/^F1[0-9]/, "SUBSTANCE_USE"],
  [/^F/, "MENTAL_HEALTH"],
  [/^(B2[0-4]|Z21)/, "HIV"],
  [/^A(5[0-9]|6[0-4])/, "SEXUAL_HEALTH"],
  [/^(O|Z3[0-9])/, "REPRODUCTIVE_HEALTH"],
];

const WORD_RULES: [RegExp, RagSensitiveCategory][] = [
  [/\b(hiv|aids|antiretroviral|art regimen|cd4)\b/i, "HIV"],
  [/\b(alcohol (use|dependence)|opioid|substance use|de-?addiction|buprenorphine|methadone)\b/i, "SUBSTANCE_USE"],
  [/\b(depress\w*|anxiety disorder|schizophren\w*|bipolar|psychos\w*|suicid\w*|self[- ]harm|psychiatr\w*|counsell?ing)\b/i, "MENTAL_HEALTH"],
  [/\b(syphilis|gonorrh\w*|chlamydia|herpes genital\w*|vdrl|rpr|tpha|sexually transmitted|sti)\b/i, "SEXUAL_HEALTH"],
  [/\b(pregnan\w*|abortion|termination of pregnancy|mtp|contracepti\w*|ivf|infertility|beta[- ]?hcg)\b/i, "REPRODUCTIVE_HEALTH"],
];

/** The first sensitive category a code or any of the texts maps to, or null. */
export function sensitiveCategoryOf(input: { code?: string | null; texts?: (string | null | undefined)[] }): RagSensitiveCategory | null {
  const code = input.code?.trim().toUpperCase();
  if (code) for (const [re, cat] of CODE_RULES) if (re.test(code)) return cat;
  const text = (input.texts ?? []).filter(Boolean).join(" \n ");
  for (const [re, cat] of WORD_RULES) if (re.test(text)) return cat;
  return null;
}
