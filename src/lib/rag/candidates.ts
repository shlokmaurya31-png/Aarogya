import { resolveEffectiveInternal } from "@/lib/config/resolver";


/**
 * RAG Phase 3, step 3.1 — how many candidates retrieval takes at each stage
 * (docs/RAG_ARCHITECTURE.md §7.1), from the configuration registry, per
 * organisation and facility. The defaults are the counts the code used
 * before (40 / 40 / 30, keeping 8, or 12 for the modes that summarise a
 * record). The evaluation compares them with the specification's 30 / 30 /
 * 20 on its development split only (eval/rag/questions.json, split "dev").
 */
export interface CandidateCounts { vector: number; keyword: number; rerank: number; keep: number; keepContext: number }

export const DEFAULT_COUNTS: CandidateCounts = { vector: 40, keyword: 40, rerank: 30, keep: 8, keepContext: 12 };
export const SPEC_COUNTS: CandidateCounts = { vector: 30, keyword: 30, rerank: 20, keep: 8, keepContext: 12 };

const KEYS: Record<keyof CandidateCounts, string> = {
  vector: "ai.retrieval.vector_candidates", keyword: "ai.retrieval.keyword_candidates", rerank: "ai.retrieval.rerank_candidates",
  keep: "ai.retrieval.keep", keepContext: "ai.retrieval.keep_context",
};

let override: CandidateCounts | null = null;
/** The evaluation's comparison of settings (scripts only). */
export function setCandidateCountsForTest(c: CandidateCounts | null) { override = c; }

export async function candidateCounts(organizationId: string | null, facilityId: string | null): Promise<CandidateCounts> {
  if (override) return override;
  if (!organizationId) return DEFAULT_COUNTS;
  const entries = await Promise.all((Object.keys(KEYS) as (keyof CandidateCounts)[]).map(async (k) => {
    const eff = await resolveEffectiveInternal({ key: KEYS[k], organizationId, facilityId: facilityId ?? undefined });
    return [k, typeof eff.value === "number" ? eff.value : DEFAULT_COUNTS[k]] as const;
  }));
  const c = Object.fromEntries(entries) as unknown as CandidateCounts;
  // The reranker sees at most what the two searches can return.
  return { ...c, rerank: Math.min(c.rerank, c.vector + c.keyword) };
}
