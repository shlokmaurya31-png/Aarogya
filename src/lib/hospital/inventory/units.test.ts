import { describe, it, expect } from "vitest";
import { unitsAreCompatible } from "./units";

describe("unitsAreCompatible — minimum conversion foundation, never a silent cross-dimension convert", () => {
  it("a unit is always compatible with itself", () => {
    expect(unitsAreCompatible("TABLET", "TABLET")).toBe(true);
  });

  it("two count-dimension units are compatible (e.g. BOX and TABLET)", () => {
    expect(unitsAreCompatible("BOX", "TABLET")).toBe(true);
  });

  it("two mass-dimension units are compatible (e.g. GRAM and KG)", () => {
    expect(unitsAreCompatible("GRAM", "KG")).toBe(true);
  });

  it("two volume-dimension units are compatible (e.g. ML and LITER)", () => {
    expect(unitsAreCompatible("ML", "LITER")).toBe(true);
  });

  it("count and mass units are NOT compatible (e.g. TABLET and GRAM)", () => {
    expect(unitsAreCompatible("TABLET", "GRAM")).toBe(false);
  });

  it("volume and count units are NOT compatible (e.g. ML and VIAL)", () => {
    expect(unitsAreCompatible("ML", "VIAL")).toBe(false);
  });

  it("OTHER is compatible with itself (same unit, no conversion needed) but never with any other unit", () => {
    expect(unitsAreCompatible("OTHER", "OTHER")).toBe(true);
    expect(unitsAreCompatible("OTHER", "TABLET")).toBe(false);
    expect(unitsAreCompatible("TABLET", "OTHER")).toBe(false);
  });
});
