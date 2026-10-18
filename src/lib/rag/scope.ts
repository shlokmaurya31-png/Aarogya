import type { RagAudience, RagCategory, RagOrigin, RagSensitiveCategory } from "@prisma/client";

/**
 * Week 4b — what one request may retrieve, as resolved by the access
 * resolver (src/lib/rag/access.ts) from server-side values only
 * (docs/RAG_DESIGN.md §7.1). One segment per access path; a chunk is a
 * candidate only if some segment admits it, and every condition is applied
 * in SQL before any ranking (src/lib/rag/search.ts).
 */
export interface ScopeSegment {
  /** The access path, for the interaction record ("TREATING", "SHARE", "OWN", …). */
  path: string;
  /** Facility chunks of these records (merge-aware ids), only from these facilities. */
  facility?: { patientIds: string[]; facilityIds: string[] };
  /** Or the chunks a Person owns (uploads, patient-provided facts). */
  personId?: string;
  /** A chunk is admitted only if ALL its categories are allowed (a patient-provided lab needs UPLOADS and LABS). */
  categories: RagCategory[];
  /** Sensitive categories opted in; empty: a sensitive chunk is never a candidate. */
  sensitive: RagSensitiveCategory[];
  audiences: RagAudience[];
  origins: RagOrigin[];
  recordedFrom?: Date;
  recordedTo?: Date;
  /** Only these sources (EXPLAIN_REPORT: the one report). */
  sourceIds?: string[];
}

export interface RetrievalScope { segments: ScopeSegment[] }

export const ALL_CATEGORIES: RagCategory[] = ["PRESCRIPTIONS", "LABS", "IMAGING", "DISCHARGE_SUMMARIES", "UPLOADS", "CLINICAL_NOTES", "DIAGNOSES", "ALLERGIES", "VITALS", "REFERRALS"];
export const ALL_SENSITIVE: RagSensitiveCategory[] = ["MENTAL_HEALTH", "SEXUAL_HEALTH", "HIV", "SUBSTANCE_USE", "REPRODUCTIVE_HEALTH"];

export function emptyScope(s: RetrievalScope): boolean {
  return s.segments.every((g) => (!g.facility || g.facility.patientIds.length === 0 || g.facility.facilityIds.length === 0) && !g.personId);
}
