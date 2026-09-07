import { describe, it, expect } from "vitest";
import { computeLineTotal, computePurchaseOrderTotals } from "./pricing";

describe("computeLineTotal — server-computed, never trusts a client total", () => {
  it("no tax: total is just quantity times unit price", () => {
    expect(computeLineTotal({ orderedQuantity: 10, unitPriceMinor: 500 })).toBe(5000);
  });

  it("applies a percentage tax on top of the gross line amount", () => {
    // 10 * 500 = 5000 gross, 5% tax = 250, total 5250
    expect(computeLineTotal({ orderedQuantity: 10, unitPriceMinor: 500, taxPercent: 5 })).toBe(5250);
  });

  it("rounds half-up on a fractional tax amount, reusing billing/money.ts's single rounding policy", () => {
    // 3 * 333 = 999 gross, 12.5% tax = 124.875 -> rounds to 125, total 1124
    expect(computeLineTotal({ orderedQuantity: 3, unitPriceMinor: 333, taxPercent: 12.5 })).toBe(1124);
  });

  it("zero tax percent is equivalent to no tax", () => {
    expect(computeLineTotal({ orderedQuantity: 4, unitPriceMinor: 250, taxPercent: 0 })).toBe(1000);
  });
});

describe("computePurchaseOrderTotals — aggregates lines into subtotal/tax/total", () => {
  it("sums multiple lines correctly, separating subtotal from tax", () => {
    const lines = [
      { orderedQuantity: 10, unitPriceMinor: 500, taxPercent: 5 }, // 5000 + 250 = 5250
      { orderedQuantity: 2, unitPriceMinor: 1000, taxPercent: 0 }, // 2000 + 0 = 2000
    ];
    const totals = computePurchaseOrderTotals(lines);
    expect(totals.subtotalMinor).toBe(7000);
    expect(totals.taxMinor).toBe(250);
    expect(totals.totalMinor).toBe(7250);
  });

  it("an empty line list totals to zero", () => {
    expect(computePurchaseOrderTotals([])).toEqual({ subtotalMinor: 0, taxMinor: 0, totalMinor: 0 });
  });
});
