/**
 * RAG Phase 5 — the sha-256 recorded for each sealed file in
 * docs/RAG_INDIC_BENCHMARK.md: a "File:" line naming it, then its
 * "sealed split sha-256:" line.
 */
export function recordedHashes(doc: string): Record<string, string> {
  return Object.fromEntries([...doc.matchAll(/File: `eval\/rag\/sealed\/(phase\d+)\.json`\s*\n- sealed split sha-256: `([0-9a-f]{64})`/g)].map((m) => [m[1], m[2]]));
}
