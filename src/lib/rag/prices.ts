import { resolveEffectiveInternal } from "@/lib/config/resolver";

/**
 * RAG Phase 4, step 4.5 — the dated price table for the per-request cost
 * estimate (docs/RAG_ARCHITECTURE.md §11.5). List prices in US dollars.
 * RAG Phase 5, step 3e: every price CHECKED on 2026-11-24 against the
 * provider's own pricing page (sources below and in ADR 0005), PENDING OWNER
 * CONFIRMATION (`confirmed` stays false until the product owner confirms the
 * account's actual rates and any discount). The organisation's
 * `ai.price_table` replaces the whole table. Cost is an estimate; it is never
 * reported as zero for work that was done: a Tier 0 answer costs its query
 * embedding and retrieval, nothing for a model.
 *
 * Reranking is billed by Voyage in tokens ("query tokens × documents + the
 * documents' tokens"), not per document: the estimate counts each document
 * scored as the query's tokens plus a chunk's target size (400 tokens; the
 * indexer's chunker), so it is an upper-side estimate.
 */
export interface PriceTable {
  asOf: string; confirmed: boolean;
  /** "checked, pending owner confirmation" once each price was read on its provider's page; the pages read. */
  status?: string; sources?: string[];
  models: Record<string, { inputPerMTok: number; outputPerMTok: number }>;
  embeddings: Record<string, { perMTok: number }>;
  rerankPerMTok: number;
}

/** The indexer's chunk target (tokens), the document side of a rerank estimate. */
export const RERANK_DOC_TOKENS = 400;

export const DEFAULT_PRICES: PriceTable = {
  asOf: "2026-11-24",
  confirmed: false,
  status: "checked, pending owner confirmation",
  sources: ["https://platform.claude.com/docs/en/about-claude/pricing", "https://docs.voyageai.com/docs/pricing"],
  models: {
    "claude-sonnet-5-5": { inputPerMTok: 2, outputPerMTok: 10 },
    // Prompts up to 100,000 tokens (longer prompts: $0.50 / $2.50; every AI request here is far below that).
    "claude-haiku-5-5": { inputPerMTok: 0.1, outputPerMTok: 0.5 },
    "claude-opus-5-5": { inputPerMTok: 4, outputPerMTok: 20 },
  },
  embeddings: { "voyage-multilingual-2": { perMTok: 0.12 } },
  // rerank-2.5.
  rerankPerMTok: 0.05,
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
    + (u.rerankUnits * (u.embeddingTokens + RERANK_DOC_TOKENS) * t.rerankPerMTok) / 1e6;
  return Math.round(usd * 1e6);
}
