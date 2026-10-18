/**
 * Phase 0 — closed vocabularies of person identity, with no imports so the
 * event catalogue can use them without an import cycle. Mirrored against the
 * Prisma enums in events.test.ts.
 */
export const PERSON_SOURCES = ["SELF_REGISTRATION", "MIGRATION"] as const;
export type PersonSource = (typeof PERSON_SOURCES)[number];

export const PERSON_LINK_METHODS = ["OTP_RECORD_CONTACT", "ABHA_BOTH_VERIFIED", "IN_PERSON_ID", "SELF_CREATED"] as const;
