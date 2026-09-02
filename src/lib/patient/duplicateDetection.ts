import { prisma } from "@/lib/db";

/**
 * Deterministic duplicate-patient matching (brief §9). Never auto-merges —
 * returns a confidence classification for a human reviewer to act on via
 * the merge workflow (src/lib/patient/merge.ts). Matching is intentionally
 * simple (no fuzzy-name/phonetic library dependency) — good enough to
 * surface real candidates, not a claim of clinically-validated identity
 * resolution.
 */
export type MatchConfidence = "NO_MATCH" | "POSSIBLE_MATCH" | "HIGH_CONFIDENCE_MATCH";

export interface DuplicateCandidate {
  patientId: string;
  uhid: string;
  fullName: string;
  confidence: MatchConfidence;
  score: number; // 0-100, for sorting/debugging — not exposed as a clinical claim
  matchedOn: string[];
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizePhone(phone: string): string {
  return phone.replace(/[^0-9]/g, "").slice(-10); // compare last 10 digits, ignores country code/formatting
}

function sameDay(a: Date | null, b: Date | null): boolean {
  if (!a || !b) return false;
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
}

/** Scores one candidate against the input against a fixed rubric — deterministic, not ML-based. Exported for unit testing without a database. */
export function scoreCandidate(
  input: { fullName: string; phone?: string; dob?: Date | null; sex?: string },
  candidate: { fullName: string; phone: string | null; dob: Date | null; sex: string }
): { score: number; matchedOn: string[] } {
  let score = 0;
  const matchedOn: string[] = [];

  if (normalizeName(input.fullName) === normalizeName(candidate.fullName)) {
    score += 40;
    matchedOn.push("name");
  } else {
    // Partial credit for a substring/token overlap (catches "Ravi Kumar" vs "Ravi K.").
    const inTokens = new Set(normalizeName(input.fullName).split(" "));
    const candTokens = new Set(normalizeName(candidate.fullName).split(" "));
    const overlap = [...inTokens].filter((t) => candTokens.has(t)).length;
    if (overlap > 0 && overlap === Math.min(inTokens.size, candTokens.size)) {
      score += 15;
      matchedOn.push("name-partial");
    }
  }

  if (input.phone && candidate.phone && normalizePhone(input.phone) === normalizePhone(candidate.phone)) {
    score += 35;
    matchedOn.push("phone");
  }

  if (input.dob && sameDay(input.dob, candidate.dob)) {
    score += 20;
    matchedOn.push("dob");
  }

  if (input.sex && candidate.sex && input.sex.toLowerCase() === candidate.sex.toLowerCase()) {
    score += 5;
    matchedOn.push("sex");
  }

  return { score, matchedOn };
}

export function classify(score: number): MatchConfidence {
  if (score >= 70) return "HIGH_CONFIDENCE_MATCH";
  if (score >= 35) return "POSSIBLE_MATCH";
  return "NO_MATCH";
}

/**
 * Finds possible duplicates for a candidate patient within the same
 * facility (never cross-facility — see docs/SECURITY_AUDIT.md S-05 on
 * tenant isolation; duplicate detection must not become a cross-tenant
 * data-leak vector).
 */
export async function findDuplicateCandidates(
  facilityId: string,
  input: { fullName: string; phone?: string; dob?: Date | null; sex?: string },
  excludePatientId?: string
): Promise<DuplicateCandidate[]> {
  const pool = await prisma.patient.findMany({
    where: {
      facilityId,
      mergedIntoId: null, // don't match against already-merged (superseded) records
      ...(excludePatientId ? { id: { not: excludePatientId } } : {}),
    },
    select: { id: true, uhid: true, fullName: true, phone: true, dob: true, sex: true },
  });

  const results: DuplicateCandidate[] = [];
  for (const candidate of pool) {
    const { score, matchedOn } = scoreCandidate(input, candidate);
    const confidence = classify(score);
    if (confidence === "NO_MATCH") continue;
    results.push({
      patientId: candidate.id,
      uhid: candidate.uhid,
      fullName: candidate.fullName,
      confidence,
      score,
      matchedOn,
    });
  }

  return results.sort((a, b) => b.score - a.score);
}
