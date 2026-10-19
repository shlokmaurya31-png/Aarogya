import { assertAiPermit } from "@/lib/ai/record/permit";
import { stem } from "@/lib/rag/stem";
import type { EmbeddingProvider } from "./types";

/**
 * Week 4b — the deterministic, offline embedding provider (CI and local;
 * docs/RAG_DESIGN.md §6.2): feature hashing of word unigrams and bigrams into
 * `dims` dimensions (FNV-1a, a sign bit from a second hash), L2-normalized.
 * Its reranker is BM25 over the candidates (stemmed content words), squashed
 * to 0..1 and weighted by how much of the question the passage covers. The model name
 * carries the dimension, so another dimension is another model (a re-embed).
 */
export function tokens(text: string): string[] {
  return text.toLowerCase().normalize("NFKC").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function fnv1a(s: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function hashEmbed(text: string, dims: number): number[] {
  const v = new Array<number>(dims).fill(0);
  const t = tokens(text);
  const features = [...t, ...t.slice(1).map((w, i) => `${t[i]} ${w}`)];
  for (const f of features) {
    const idx = fnv1a(f) % dims;
    const sign = fnv1a(f, 0x9747b28c) & 1 ? 1 : -1;
    v[idx] += sign;
  }
  const norm = Math.hypot(...v);
  return norm === 0 ? v : v.map((x) => x / norm);
}

/** Function words a question is made of; they say nothing about which entry answers it. */
const QUERY_STOP = new Set(["a", "an", "the", "is", "are", "was", "were", "be", "been", "of", "in", "on", "at", "to", "for", "and", "or", "with", "what", "which", "when", "who", "how", "does", "do", "did", "has", "have", "had", "any", "anything", "this", "that", "it", "its", "her", "his", "their", "my", "me", "i", "patient", "patient's", "s", "tell", "show", "about", "latest", "last", "current", "recent", "value", "values", "result", "results", "level", "reading", "recorded", "mean", "means", "there"]);

/** The query's content words, stemmed (shared by the reranker's coverage). */
export function queryTerms(query: string): string[] {
  return [...new Set(tokens(query).filter((w) => !QUERY_STOP.has(w)).map(stem))];
}

/** BM25 (k1 1.2, b 0.75) of each document for the query's content words (stemmed), over this candidate set. */
export function bm25(query: string, documents: string[]): number[] {
  const q = queryTerms(query);
  const docs = documents.map((d) => tokens(d).map(stem));
  const avg = docs.reduce((n, d) => n + d.length, 0) / Math.max(1, docs.length);
  const df = new Map(q.map((w) => [w, docs.filter((d) => d.includes(w)).length]));
  return docs.map((d) => q.reduce((score, w) => {
    const f = d.filter((x) => x === w).length;
    if (!f) return score;
    const n = df.get(w)!;
    const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
    return score + (idf * f * 2.2) / (f + 1.2 * (0.25 + (0.75 * d.length) / Math.max(1, avg)));
  }, 0));
}

export function mockEmbeddings(dims = 1024): EmbeddingProvider {
  return {
    id: "mock",
    model: `mock-hash-${dims}`,
    dimensions: dims,
    async embed(texts, _inputType, permit) {
      assertAiPermit(permit);
      return texts.map((t) => hashEmbed(t, dims));
    },
    async rerank(query, documents, permit) {
      assertAiPermit(permit);
      // Relevance also needs coverage: a passage matching one word of a four-word question is weak evidence.
      const q = queryTerms(query);
      return bm25(query, documents).map((s, index) => {
        const words = new Set(tokens(documents[index]).map(stem));
        const coverage = q.length ? q.filter((w) => words.has(w)).length / q.length : 0;
        return { index, score: (1 - Math.exp(-s / 2)) * Math.sqrt(coverage) };
      });
    },
  };
}
