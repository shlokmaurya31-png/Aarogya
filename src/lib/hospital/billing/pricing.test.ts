import { describe, it, expect } from "vitest";
import { dateRangesOverlap } from "./pricing";

const d = (s: string) => new Date(s);

describe("dateRangesOverlap — effective-dated tariff overlap predicate", () => {
  it("detects an exact-match overlap", () => {
    expect(dateRangesOverlap(d("2027-01-01"), d("2027-02-01"), d("2027-01-01"), d("2027-02-01"))).toBe(true);
  });

  it("detects a partial overlap", () => {
    expect(dateRangesOverlap(d("2027-01-01"), d("2027-02-01"), d("2027-01-15"), d("2027-02-15"))).toBe(true);
  });

  it("detects one range fully containing another", () => {
    expect(dateRangesOverlap(d("2027-01-01"), d("2027-03-01"), d("2027-01-15"), d("2027-01-20"))).toBe(true);
  });

  it("treats adjacent ranges as non-overlapping (half-open interval semantics)", () => {
    expect(dateRangesOverlap(d("2027-01-01"), d("2027-02-01"), d("2027-02-01"), d("2027-03-01"))).toBe(false);
  });

  it("treats a genuinely disjoint later range as non-overlapping", () => {
    expect(dateRangesOverlap(d("2027-01-01"), d("2027-02-01"), d("2027-06-01"), d("2027-07-01"))).toBe(false);
  });

  it("an open-ended existing tariff (effectiveTo: null) overlaps any later range", () => {
    expect(dateRangesOverlap(d("2027-01-01"), null, d("2027-06-01"), d("2027-07-01"))).toBe(true);
  });

  it("two open-ended tariffs starting at different dates overlap", () => {
    expect(dateRangesOverlap(d("2027-01-01"), null, d("2027-06-01"), null)).toBe(true);
  });

  it("a new open-ended tariff does not overlap a fully-past, already-closed tariff", () => {
    expect(dateRangesOverlap(d("2026-01-01"), d("2026-06-01"), d("2027-01-01"), null)).toBe(false);
  });
});
