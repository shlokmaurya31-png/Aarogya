/** Normalizes free-text diagnostic concepts for structured matching (not exact-string equality). */
export function normalizeDiagnosisText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(acute|chronic|suspected|probable|likely|possible|early|late|stage)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Token-overlap similarity, 0..1. Cheap stand-in for real concept matching (e.g. SNOMED-backed) — good enough to avoid brittle exact-string grading. */
export function diagnosisSimilarity(a: string, b: string): number {
  const na = normalizeDiagnosisText(a);
  const nb = normalizeDiagnosisText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const tokensA = new Set(na.split(" ").filter((t) => t.length > 2));
  const tokensB = new Set(nb.split(" ").filter((t) => t.length > 2));
  if (tokensA.size === 0 || tokensB.size === 0) return na.includes(nb) || nb.includes(na) ? 0.8 : 0;

  let overlap = 0;
  for (const t of tokensA) if (tokensB.has(t)) overlap += 1;
  const union = new Set([...tokensA, ...tokensB]).size;
  const jaccard = overlap / union;

  if (na.includes(nb) || nb.includes(na)) return Math.max(jaccard, 0.75);
  return jaccard;
}

export function diagnosisMatches(candidate: string, reference: string, threshold = 0.5): boolean {
  return diagnosisSimilarity(candidate, reference) >= threshold;
}
