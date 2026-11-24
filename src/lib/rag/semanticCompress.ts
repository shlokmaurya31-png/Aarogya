import { resolveEffectiveInternal } from "@/lib/config/resolver";
import { lostFacts } from "./compress";

/**
 * RAG Phase 4 — semantic compression, level 2 (docs/RAG_ARCHITECTURE.md
 * §11.3): only where the plan allows it, which is narrow:
 *   - only for a passage that does not fit the budget after level 1, instead
 *     of dropping it;
 *   - only when the organisation turned `ai.compression.semantic` on (default
 *     off), and the compressor is in process (the mock) or a provider whose
 *     data flag allows this data (none is on: every per-provider PHI flag
 *     stays off, so only the mock runs);
 *   - never the only evidence for a critical fact: a compressed passage is
 *     used only if every critical fact of the original is still in it, and
 *     the original stays the citation and the text the validator checks.
 */
export interface SemanticCompressor {
  readonly id: "mock";
  compress(text: string): Promise<string>;
}

/** The offline compressor: the sentences that carry a critical fact, in order; the rest dropped. */
export const mockSemanticCompressor: SemanticCompressor = {
  id: "mock",
  async compress(text) {
    const sentences = text.split(/(?<=[.!?।])\s+|\n+/u).filter(Boolean);
    const kept = sentences.filter((s) => lostFacts(s, "").length > 0);
    return (kept.length ? kept : sentences.slice(0, 1)).join(" ");
  },
};

let compressor: SemanticCompressor | null = mockSemanticCompressor;
export function setSemanticCompressorForTest(c: SemanticCompressor | null) { compressor = c; }

export async function semanticCompressionAllowed(organizationId: string | null): Promise<boolean> {
  if (!organizationId || !compressor) return false;
  const eff = await resolveEffectiveInternal({ key: "ai.compression.semantic", organizationId, fallbackRaw: "false" });
  return eff.value === true;
}

/** The compressed text, or null when it would lose a critical fact (the passage is then dropped, never sent shortened). */
export async function compressPassage(text: string): Promise<string | null> {
  if (!compressor) return null;
  const out = await compressor.compress(text);
  return out.length < text.length && lostFacts(text, out).length === 0 ? out : null;
}
