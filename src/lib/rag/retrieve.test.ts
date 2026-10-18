import { describe, expect, it } from "vitest";
import { fuse, modeThreshold } from "./retrieve";
import { orTsQuery, scopeSql } from "./search";
import { AI_MODES, MODES } from "./modes";

/** Week 4b, RAG step 7: fusion, thresholds and the scope predicate (pure parts). */
describe("reciprocal-rank fusion", () => {
  it("rewards a chunk found by both searches over one found by either", () => {
    const out = fuse([
      { chunkId: "vector-only", vectorRank: 1, keywordRank: null },
      { chunkId: "both", vectorRank: 3, keywordRank: 2 },
      { chunkId: "keyword-only", vectorRank: null, keywordRank: 1 },
    ]);
    expect(out.map((c) => c.chunkId)).toEqual(["both", "keyword-only", "vector-only"]);
    expect(out[0].rrf).toBeCloseTo(1 / 63 + 1 / 62, 10);
  });
  it("breaks exact ties by id (deterministic)", () => {
    expect(fuse([{ chunkId: "b", vectorRank: 1, keywordRank: null }, { chunkId: "a", vectorRank: null, keywordRank: 1 }]).map((c) => c.chunkId)).toEqual(["a", "b"]);
  });
});

describe("thresholds", () => {
  it("are the mode's defaults; a patient mode's never falls below the highest staff mode's", async () => {
    const staffMax = Math.max(...AI_MODES.filter((m) => MODES[m].audience === "STAFF").map((m) => MODES[m].defaultThreshold / 1000));
    for (const m of AI_MODES) {
      const t = await modeThreshold(m, null, null);
      if (MODES[m].audience === "PATIENT") expect(t).toBeGreaterThanOrEqual(staffMax);
      else expect(t).toBe(MODES[m].defaultThreshold / 1000);
    }
  });
});

describe("the scope predicate", () => {
  it("admits nothing for an empty scope, and sanitizes keyword queries", () => {
    expect(scopeSql({ segments: [] }).sql).toBe("false");
    expect(scopeSql({ segments: [{ path: "X", categories: [], sensitive: [], audiences: ["STAFF_ONLY"], origins: ["VERIFIED"], personId: "p" }] }).sql).toBe("false");
    expect(orTsQuery(["Hb!", "it's", "a", "11.2", "hb"])).toBe("hb | its | 112");
  });
  it("excludes sensitive chunks unless a category is opted in, and requires every category", () => {
    const sql = scopeSql({ segments: [{ path: "X", personId: "p", categories: ["LABS"], sensitive: [], audiences: ["PATIENT_VISIBLE"], origins: ["PATIENT_PROVIDED"] }] }).sql;
    expect(sql).toContain(`c."sensitiveCategory" IS NULL`);
    expect(sql).toContain(`c."categories" <@`);
    expect(sql).toContain(`c."status" = 'ACTIVE'`);
  });
});
