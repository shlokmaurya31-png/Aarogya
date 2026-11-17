import { describe, expect, it } from "vitest";
import { ndcgAt, precisionAt, recallAt, reciprocalRank, summarize } from "./metrics";

const rel = (x: string) => x.startsWith("r");

describe("retrieval metrics (RAG Phase 1, step 1.8)", () => {
  it("recall@k counts relevant items in the top k against all relevant ones", () => {
    const j = { ranked: ["x", "r1", "y", "r2"], relevant: rel };
    expect(recallAt(j, 2)).toBe(0.5);
    expect(recallAt(j, 4)).toBe(1);
    expect(recallAt({ ...j, totalRelevant: 4 }, 4)).toBe(0.5);
  });
  it("precision@k is the relevant share of the top k", () => {
    expect(precisionAt({ ranked: ["r1", "x", "r2", "y"], relevant: rel }, 4)).toBe(0.5);
  });
  it("MRR is 1 over the first relevant rank, 0 when there is none", () => {
    expect(reciprocalRank({ ranked: ["x", "y", "r1"], relevant: rel })).toBeCloseTo(1 / 3);
    expect(reciprocalRank({ ranked: ["x", "y"], relevant: rel })).toBe(0);
  });
  it("nDCG is 1 for the ideal order and lower when the relevant item sinks", () => {
    expect(ndcgAt({ ranked: ["r1", "x", "y"], relevant: rel }, 10)).toBe(1);
    expect(ndcgAt({ ranked: ["x", "y", "r1"], relevant: rel }, 10)).toBeCloseTo(0.5);
    expect(ndcgAt({ ranked: ["x", "y"], relevant: rel, totalRelevant: 1 }, 10)).toBe(0);
  });
  it("summarizes means", () => {
    const s = summarize([{ ranked: ["r1"], relevant: rel }, { ranked: ["x"], relevant: rel, totalRelevant: 1 }], 1);
    expect(s).toMatchObject({ n: 2, recall: 0.5, precision: 0.5, mrr: 0.5, ndcg: 0.5 });
  });
});
