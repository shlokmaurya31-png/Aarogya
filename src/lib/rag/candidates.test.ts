import { afterEach, describe, expect, it } from "vitest";
import { candidateCounts, DEFAULT_COUNTS, setCandidateCountsForTest, SPEC_COUNTS } from "./candidates";
import { resolveKeySpec } from "@/lib/config/registry";

/** RAG Phase 3, step 3.1: the counts are configuration, with today's values as the defaults. */
describe("candidate counts", () => {
  afterEach(() => setCandidateCountsForTest(null));
  it("defaults to the counts the code used before (40 / 40 / 30, keep 8 or 12)", async () => {
    expect(DEFAULT_COUNTS).toEqual({ vector: 40, keyword: 40, rerank: 30, keep: 8, keepContext: 12 });
    expect(await candidateCounts(null, null)).toEqual(DEFAULT_COUNTS);
  });
  it("registers every count as a bounded number with that default", () => {
    for (const [key, d] of [["ai.retrieval.vector_candidates", "40"], ["ai.retrieval.keyword_candidates", "40"], ["ai.retrieval.rerank_candidates", "30"], ["ai.retrieval.keep", "8"], ["ai.retrieval.keep_context", "12"]] as const) {
      const spec = resolveKeySpec(key);
      expect(spec?.valueType).toBe("NUMBER");
      expect(String(spec?.default)).toBe(d);
    }
  });
  it("can be set for the evaluation's comparison with the specification's 30 / 30 / 20", async () => {
    setCandidateCountsForTest(SPEC_COUNTS);
    expect(await candidateCounts("org", "fac")).toEqual(SPEC_COUNTS);
  });
});
