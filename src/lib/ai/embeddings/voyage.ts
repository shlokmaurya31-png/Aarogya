import { z } from "zod";
import { assertAiPermit } from "@/lib/ai/record/permit";
import { EmbeddingUnavailableError, type EmbeddingProvider } from "./types";

/**
 * Week 4b — Voyage embeddings and rerank (docs/RAG_DESIGN.md §6.2): a
 * multilingual model at 1024 dimensions plus its reranker, for SYNTHETIC
 * data only: it refuses a permit for real data until the DPDP cross-border
 * check for this processor is done (pre-launch items 3–4) and this guard is
 * changed on purpose. Errors become closed codes; the key is never logged.
 */
export const VOYAGE_DEFAULTS = { model: "voyage-multilingual-2", rerankModel: "rerank-2", dims: 1024 } as const;

const EMBED_OUT = z.object({ data: z.array(z.object({ embedding: z.array(z.number()), index: z.number().int() })) });
const RERANK_OUT = z.object({ data: z.array(z.object({ index: z.number().int(), relevance_score: z.number() })) });

export function voyageEmbeddings(apiKey: string, opts: { model?: string; rerankModel?: string; dims?: number; fetchImpl?: typeof fetch } = {}): EmbeddingProvider {
  const model = opts.model ?? VOYAGE_DEFAULTS.model;
  const dims = opts.dims ?? VOYAGE_DEFAULTS.dims;
  const doFetch = opts.fetchImpl ?? fetch;
  async function post<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`https://api.voyageai.com/v1/${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new EmbeddingUnavailableError("PROVIDER_UNAVAILABLE");
    }
    if (res.status === 429) throw new EmbeddingUnavailableError("RATE_LIMITED");
    if (!res.ok) throw new EmbeddingUnavailableError("PROVIDER_UNAVAILABLE");
    const parsed = schema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new EmbeddingUnavailableError("BAD_RESPONSE");
    return parsed.data;
  }
  const guard = (permit: Parameters<EmbeddingProvider["embed"]>[2]) => {
    assertAiPermit(permit);
    if (permit.real) throw new EmbeddingUnavailableError("REAL_DATA_REFUSED");
  };
  return {
    id: "voyage",
    model,
    dimensions: dims,
    async embed(texts, inputType, permit) {
      guard(permit);
      if (!texts.length) return [];
      const r = await post("embeddings", { input: texts, model, input_type: inputType }, EMBED_OUT);
      const out = new Array<number[]>(texts.length);
      for (const d of r.data) out[d.index] = d.embedding;
      if (out.some((v) => !v || v.length !== dims)) throw new EmbeddingUnavailableError("BAD_RESPONSE");
      return out;
    },
    async rerank(query, documents, permit) {
      guard(permit);
      if (!documents.length) return [];
      const r = await post("rerank", { query, documents, model: opts.rerankModel ?? VOYAGE_DEFAULTS.rerankModel }, RERANK_OUT);
      return r.data.map((d) => ({ index: d.index, score: d.relevance_score }));
    },
  };
}
