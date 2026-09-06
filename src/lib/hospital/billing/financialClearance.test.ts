import { describe, it, expect } from "vitest";
import { classifyClearance } from "./financialClearance";

describe("classifyClearance", () => {
  it("is CLEARED when there are no outstanding reasons", () => {
    expect(classifyClearance([])).toBe("CLEARED");
  });

  it("is PENDING when any reason is present (e.g. outstanding balance)", () => {
    expect(classifyClearance(["Outstanding balance of 50000 paise across issued invoices."])).toBe("PENDING");
  });

  it("is PENDING when multiple reasons are present", () => {
    expect(classifyClearance(["Outstanding balance.", "1 claim(s) still in progress with the payer."])).toBe("PENDING");
  });
});
