import { createHash } from "node:crypto";

/**
 * RAG Phase 3, step 3.7 — building the context (docs/RAG_ARCHITECTURE.md §7.4),
 * the pure parts:
 *   1  structured facts first: a passage about the same source row as a
 *      reader's fact is dropped, the reader's value is used;
 *   2  passages deduplicated by a hash of their normalised text (the same
 *      words twice are one source), the better-ranked kept.
 * Neighbours (3) are added by retrieve.ts inside the same scope filter.
 */
export const textKey = (text: string) => createHash("sha256").update(text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim()).digest("hex");

export function dedupePassages<T extends { text: string }>(ranked: readonly T[]): T[] {
  const seen = new Set<string>();
  return ranked.filter((c) => { const k = textKey(c.text); if (seen.has(k)) return false; seen.add(k); return true; });
}

export function dropCoveredByFacts<T extends { sourceType: string; sourceId: string }>(chunks: readonly T[], facts: readonly { sourceType: string; sourceId: string }[]): T[] {
  const covered = new Set(facts.map((f) => `${f.sourceType}:${f.sourceId}`));
  return chunks.filter((c) => !covered.has(`${c.sourceType}:${c.sourceId}`));
}
