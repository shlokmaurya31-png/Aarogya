import { mockEmbeddings } from "./mock";
import { voyageEmbeddings } from "./voyage";
import { EmbeddingUnavailableError, type EmbeddingProvider } from "./types";

export * from "./types";

/**
 * Week 4b — the provider for an embedding space (RagEmbeddingSpace):
 *   mock          offline, any dimension (CI, local, gates);
 *   voyage        needs VOYAGE_API_KEY; synthetic data only;
 *   india-hosted  deferred (decision 8): the slot exists so a space can name
 *                 it, but nothing implements it yet, so it refuses.
 */
export interface SpaceRef { embeddingModel: string; provider: string; dims: number }

let override: ((space: SpaceRef) => EmbeddingProvider) | null = null;

export function embeddingProviderFor(space: SpaceRef, env: Record<string, string | undefined> = process.env): EmbeddingProvider {
  if (override) return override(space);
  if (space.provider === "mock") {
    const p = mockEmbeddings(space.dims);
    if (p.model !== space.embeddingModel) throw new EmbeddingUnavailableError("BAD_RESPONSE");
    return p;
  }
  if (space.provider === "voyage") {
    if (!env.VOYAGE_API_KEY) throw new EmbeddingUnavailableError("NO_KEY");
    return voyageEmbeddings(env.VOYAGE_API_KEY, { model: space.embeddingModel, dims: space.dims });
  }
  throw new EmbeddingUnavailableError("DEFERRED");
}

/** Tests and gates only. */
export function setEmbeddingProviderForTest(f: ((space: SpaceRef) => EmbeddingProvider) | null): void {
  override = f;
}
