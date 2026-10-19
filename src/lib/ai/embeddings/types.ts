import type { AiPermit } from "@/lib/ai/record/types";

/**
 * Week 4b — the embeddings and rerank boundary (docs/RAG_DESIGN.md §6.2;
 * ADR 0003). Which provider runs is decided by the embedding space being
 * written or read (RagEmbeddingSpace.provider), never by a request. Every
 * call needs an AI permit; an external provider refuses one for real data
 * (Voyage is for synthetic data until the cross-border check, §6.2).
 */
export interface EmbeddingProvider {
  readonly id: "voyage" | "india-hosted" | "mock";
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[], inputType: "document" | "query", permit: AiPermit): Promise<number[][]>;
  /** Scores in 0..1, higher is more relevant; one per document, in any order. */
  rerank?(query: string, documents: string[], permit: AiPermit): Promise<{ index: number; score: number }[]>;
}

export class EmbeddingUnavailableError extends Error {
  constructor(readonly code: "NO_KEY" | "DEFERRED" | "PROVIDER_UNAVAILABLE" | "RATE_LIMITED" | "REAL_DATA_REFUSED" | "BAD_RESPONSE") {
    super(`Embedding provider unavailable: ${code}`);
    this.name = "EmbeddingUnavailableError";
  }
}
