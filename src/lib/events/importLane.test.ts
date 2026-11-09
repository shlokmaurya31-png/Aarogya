import { describe, expect, it } from "vitest";
import { importLaneConcurrency, IMPORT_LANE_CONCURRENCY_DEFAULT, IMPORT_LANE_CONCURRENCY_MAX } from "./dispatcher";

describe("importLaneConcurrency (Flagship 4c)", () => {
  it("takes 1 to the cap", () => {
    expect(importLaneConcurrency("1")).toBe(1);
    expect(importLaneConcurrency("8")).toBe(8);
    expect(importLaneConcurrency(String(IMPORT_LANE_CONCURRENCY_MAX))).toBe(IMPORT_LANE_CONCURRENCY_MAX);
  });
  it("falls back to the default for anything else", () => {
    for (const v of [undefined, "", " ", "0", "17", "2.5", "four", "-1"]) expect(importLaneConcurrency(v)).toBe(IMPORT_LANE_CONCURRENCY_DEFAULT);
  });
});
