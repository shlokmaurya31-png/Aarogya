/**
 * RAG Phase 1, step 1.8 — retrieval metrics (docs/RAG_IMPLEMENTATION_PLAN.md
 * §3.1). Binary relevance: `ranked` is what retrieval returned, best first;
 * `relevant` says which of them count. Pure.
 *
 *   recall@k     the share of relevant items found in the top k (of all
 *                relevant items, `totalRelevant`; at least 1)
 *   precision@k  the share of the top k that is relevant
 *   MRR          1 / the rank of the first relevant item (0 if none)
 *   nDCG@k       DCG of the ranking over the ideal DCG (log2 discount)
 */
export interface RankedJudgement<T> { ranked: readonly T[]; relevant: (item: T) => boolean; totalRelevant?: number }

const hits = <T,>(j: RankedJudgement<T>, k: number) => j.ranked.slice(0, k).filter(j.relevant).length;
const total = <T,>(j: RankedJudgement<T>) => Math.max(1, j.totalRelevant ?? j.ranked.filter(j.relevant).length);

export function recallAt<T>(j: RankedJudgement<T>, k: number): number {
  return Math.min(1, hits(j, k) / total(j));
}

export function precisionAt<T>(j: RankedJudgement<T>, k: number): number {
  return k > 0 ? hits(j, k) / k : 0;
}

export function reciprocalRank<T>(j: RankedJudgement<T>): number {
  const i = j.ranked.findIndex(j.relevant);
  return i < 0 ? 0 : 1 / (i + 1);
}

export function ndcgAt<T>(j: RankedJudgement<T>, k: number): number {
  const gain = (rank: number) => 1 / Math.log2(rank + 2);
  let dcg = 0;
  j.ranked.slice(0, k).forEach((x, i) => { if (j.relevant(x)) dcg += gain(i); });
  let ideal = 0;
  for (let i = 0; i < Math.min(k, total(j)); i++) ideal += gain(i);
  return ideal ? dcg / ideal : 0;
}

export interface MetricSummary { n: number; recall: number; precision: number; mrr: number; ndcg: number }

/** Means over a set of judgements, at one k (nDCG at `ndcgK`, default 10). */
export function summarize<T>(js: readonly RankedJudgement<T>[], k: number, ndcgK = 10): MetricSummary {
  const n = js.length;
  const mean = (f: (j: RankedJudgement<T>) => number) => (n ? js.reduce((s, j) => s + f(j), 0) / n : 0);
  return { n, recall: mean((j) => recallAt(j, k)), precision: mean((j) => precisionAt(j, k)), mrr: mean(reciprocalRank), ndcg: mean((j) => ndcgAt(j, ndcgK)) };
}
