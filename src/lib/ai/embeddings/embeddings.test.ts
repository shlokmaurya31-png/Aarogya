import { describe, expect, it } from "vitest";
import { issueAiPermit } from "@/lib/ai/record/permit";
import type { AiPermit } from "@/lib/ai/record/types";
import { embeddingProviderFor, EmbeddingUnavailableError } from "./index";
import { bm25, hashEmbed, mockEmbeddings } from "./mock";
import { voyageEmbeddings } from "./voyage";

/** Week 4b, RAG step 4: the embeddings adapter. */
const synthetic = issueAiPermit("t", false);
const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

describe("mock embeddings", () => {
  it("are deterministic, L2-normalized and of the model's dimension", async () => {
    const m = mockEmbeddings(1024);
    const [a, b] = await m.embed(["Hemoglobin 11.2 g/dL", "Hemoglobin 11.2 g/dL"], "document", synthetic);
    expect(a).toEqual(b);
    expect(a).toHaveLength(1024);
    expect(Math.hypot(...a)).toBeCloseTo(1, 6);
    expect(m.model).toBe("mock-hash-1024");
    expect((await mockEmbeddings(384).embed(["x y"], "query", synthetic))[0]).toHaveLength(384);
  });
  it("put similar texts closer than unrelated ones", () => {
    const q = hashEmbed("latest hemoglobin result", 1024);
    expect(cos(q, hashEmbed("Lab result: hemoglobin 11.2 g/dL, low", 1024))).toBeGreaterThan(cos(q, hashEmbed("Wound clean and dry, dressing changed", 1024)));
  });
  it("rerank (BM25) puts the matching document first, scores in 0..1", async () => {
    const r = await mockEmbeddings().rerank!("creatinine", ["Sodium 138 mEq/L", "Creatinine 1.42 mg/dL, high", "Plan: repeat labs"], synthetic);
    const best = [...r].sort((a, b) => b.score - a.score)[0];
    expect(best.index).toBe(1);
    expect(r.every((x) => x.score >= 0 && x.score < 1)).toBe(true);
    expect(bm25("absent", ["a b c"])[0]).toBe(0);
    // Function words in a question never make a document relevant.
    expect(bm25("what is the blood group?", ["see the allergy list", "it is what it is"])).toEqual([0, 0]);
  });
  it("need a permit", async () => {
    await expect(mockEmbeddings().embed(["x"], "query", {} as AiPermit)).rejects.toThrow(/permit/);
  });
});

describe("provider for a space", () => {
  it("mock for a mock space (the name carries the dimension); Voyage needs its key; India-hosted is deferred", () => {
    expect(embeddingProviderFor({ embeddingModel: "mock-hash-1024", provider: "mock", dims: 1024 }, {}).id).toBe("mock");
    expect(() => embeddingProviderFor({ embeddingModel: "mock-hash-1024", provider: "mock", dims: 384 }, {})).toThrow(EmbeddingUnavailableError);
    expect(() => embeddingProviderFor({ embeddingModel: "voyage-multilingual-2", provider: "voyage", dims: 1024 }, {})).toThrow(/NO_KEY/);
    expect(embeddingProviderFor({ embeddingModel: "voyage-multilingual-2", provider: "voyage", dims: 1024 }, { VOYAGE_API_KEY: "k" }).id).toBe("voyage");
    expect(() => embeddingProviderFor({ embeddingModel: "x", provider: "india-hosted", dims: 768 }, {})).toThrow(/DEFERRED/);
  });
});

describe("Voyage (stubbed fetch: no network)", () => {
  const calls: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, body, auth: new Headers(init.headers).get("authorization") });
    if (url.endsWith("/embeddings")) return new Response(JSON.stringify({ data: (body.input as string[]).map((_, index) => ({ index, embedding: new Array(1024).fill(0.01) })) }));
    return new Response(JSON.stringify({ data: [{ index: 0, relevance_score: 0.9 }] }));
  }) as unknown as typeof fetch;
  const v = voyageEmbeddings("secret-key", { fetchImpl });
  it("embeds with the document/query input type and its bearer key", async () => {
    const out = await v.embed(["a", "b"], "query", synthetic);
    expect(out).toHaveLength(2);
    expect(calls[0].body).toEqual({ input: ["a", "b"], model: "voyage-multilingual-2", input_type: "query" });
    expect(calls[0].auth).toBe("Bearer secret-key");
    expect((await v.rerank!("q", ["d"], synthetic))[0]).toEqual({ index: 0, score: 0.9 });
  });
  it("refuses real data (synthetic only until the cross-border check)", async () => {
    await expect(v.embed(["a"], "document", issueAiPermit("p", true))).rejects.toThrow(/REAL_DATA_REFUSED/);
  });
  it("turns a failure into a closed code", async () => {
    const down = voyageEmbeddings("k", { fetchImpl: (async () => new Response("no", { status: 500 })) as unknown as typeof fetch });
    await expect(down.embed(["a"], "document", synthetic)).rejects.toThrow(/PROVIDER_UNAVAILABLE/);
    const limited = voyageEmbeddings("k", { fetchImpl: (async () => new Response("no", { status: 429 })) as unknown as typeof fetch });
    await expect(limited.embed(["a"], "document", synthetic)).rejects.toThrow(/RATE_LIMITED/);
  });
});
