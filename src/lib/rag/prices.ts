import { resolveEffectiveInternal } from "@/lib/config/resolver";

/**
 * RAG Phase 4, step 4.5 — the dated price table for the per-request cost
 * estimate (docs/RAG_ARCHITECTURE.md §11.5). List prices in US dollars,
 * UNCONFIRMED: Anthropic's from the Claude API reference cached 2026-10-06
 * (no account to confirm them on), Voyage's not checked (no key). The
 * organisation's `ai.price_table` replaces the whole table. Cost is an
 * estimate; it is never reported as zero for work that was done: a Tier 0
 * answer costs its query embedding and retrieval, nothing for a model.
 */
export interface PriceTable {
  asOf: string; confirmed: boolean;
  models: Record<string, { inputPerMTok: number; outputPerMTok: number }>;
  embeddings: Record<string, { perMTok: number }>;
  rerankPerThousand: number;
}

export const DEFAULT_PRICES: PriceTable = {
  asOf: "2026-10-06",
  confirmed: false,
  models: {
    "claude-sonnet-5-5": { inputPerMTok: 2, outputPerMTok: 10 },
    "claude-haiku-5-5": { inputPerMTok: 0.1, outputPerMTok: 0.5 },
    "claude-opus-5-5": { inputPerMTok: 4, outputPerMTok: 20 },
  },
  embeddings: { "voyage-multilingual-2": { perMTok: 0.12 } },
  rerankPerThousand: 0.05,
};

export async function priceTable(organizationId: string | null): Promise<PriceTable> {
  if (!organizationId) return DEFAULT_PRICES;
  const eff = await resolveEffectiveInternal({ key: "ai.price_table", organizationId, fallbackRaw: JSON.stringify(DEFAULT_PRICES) });
  return (eff.value as PriceTable | null) ?? DEFAULT_PRICES;
}

/**
 * Millionths of a US dollar. A mock model or space is priced as the model it
 * stands in for (`pricedAs`), so the estimate shows what the request would
 * cost on the configured provider.
 */
export function estimateCostMicroUsd(t: PriceTable, u: { model: string; pricedAs?: string; inputTokens: number; outputTokens: number; embeddingModel?: string; embeddingTokens: number; rerankUnits: number }): number {
  const m = t.models[u.pricedAs ?? u.model] ?? t.models[u.model];
  const e = u.embeddingModel ? t.embeddings[u.embeddingModel] : undefined;
  const usd = (m ? (u.inputTokens * m.inputPerMTok + u.outputTokens * m.outputPerMTok) / 1e6 : 0)
    + (e ? (u.embeddingTokens * e.perMTok) / 1e6 : 0)
    + (u.rerankUnits * t.rerankPerThousand) / 1000;
  return Math.round(usd * 1e6);
}
