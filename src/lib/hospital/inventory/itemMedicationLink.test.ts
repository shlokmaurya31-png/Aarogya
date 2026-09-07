import { describe, it, expect } from "vitest";
import { normalizeDrugName } from "./itemMedicationLink";

describe("normalizeDrugName — the MedicationItemLink matching key", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeDrugName("  Amoxicillin  ")).toBe("AMOXICILLIN");
  });

  it("upper-cases so lookups are case-insensitive", () => {
    expect(normalizeDrugName("amoxicillin")).toBe("AMOXICILLIN");
    expect(normalizeDrugName("Amoxicillin")).toBe("AMOXICILLIN");
    expect(normalizeDrugName("AMOXICILLIN")).toBe("AMOXICILLIN");
  });

  it("distinct drug names never collide after normalization", () => {
    expect(normalizeDrugName("Metformin")).not.toBe(normalizeDrugName("Metronidazole"));
  });
});
