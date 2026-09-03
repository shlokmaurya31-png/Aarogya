import { describe, it, expect } from "vitest";
import { computeAbnormalFlag } from "./labCatalog";
import type { LabReferenceRange } from "@prisma/client";

function range(overrides: Partial<LabReferenceRange>): LabReferenceRange {
  return {
    id: "range-1",
    catalogTestId: "test-1",
    low: null,
    high: null,
    criticalLow: null,
    criticalHigh: null,
    unit: null,
    sex: null,
    minAgeYears: null,
    maxAgeYears: null,
    effectiveFrom: new Date(),
    effectiveTo: null,
    isDemoData: true,
    sourceNote: "Demo/reference configuration — not clinically validated",
    ...overrides,
  };
}

describe("computeAbnormalFlag", () => {
  it("returns null when no range is configured — never guesses", () => {
    expect(computeAbnormalFlag(999, null)).toBeNull();
  });

  it("flags NORMAL when within low/high", () => {
    expect(computeAbnormalFlag(140, range({ low: 135, high: 145 }))).toBe("NORMAL");
  });

  it("flags LOW when below low", () => {
    expect(computeAbnormalFlag(130, range({ low: 135, high: 145 }))).toBe("LOW");
  });

  it("flags HIGH when above high", () => {
    expect(computeAbnormalFlag(150, range({ low: 135, high: 145 }))).toBe("HIGH");
  });

  it("flags CRITICAL_LOW when below criticalLow, even if also below low", () => {
    expect(computeAbnormalFlag(100, range({ low: 135, high: 145, criticalLow: 120 }))).toBe("CRITICAL_LOW");
  });

  it("flags CRITICAL_HIGH when above criticalHigh, even if also above high", () => {
    expect(computeAbnormalFlag(0.8, range({ high: 0.04, criticalHigh: 0.5 }))).toBe("CRITICAL_HIGH");
  });

  it("treats a boundary value as NORMAL (inclusive range edges)", () => {
    expect(computeAbnormalFlag(145, range({ low: 135, high: 145 }))).toBe("NORMAL");
  });
});
