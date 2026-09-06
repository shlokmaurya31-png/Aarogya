import { describe, it, expect } from "vitest";
import { computeLineNetAmountMinor } from "./money";

// createCharge/createChargeIfNotExists themselves are thin DB-transaction
// wrappers (no branching logic beyond the P2002 idempotency catch, already
// proven by Phase 4's identical pattern) — the one piece of real business
// logic they contain is the net-amount arithmetic, which computeLineNetAmountMinor
// already covers directly. These tests pin the specific charge-capture
// scenarios (quantity/discount combinations a real charge would use).
describe("charge net-amount arithmetic (as used by createCharge)", () => {
  it("a single consultation charge with no discount nets to the full unit price", () => {
    expect(computeLineNetAmountMinor(1, 50000, 0)).toBe(50000);
  });

  it("a multi-day bed charge (quantity > 1) multiplies correctly", () => {
    expect(computeLineNetAmountMinor(3, 200000, 0)).toBe(600000);
  });

  it("a discounted charge nets to gross minus discount", () => {
    expect(computeLineNetAmountMinor(1, 100000, 15000)).toBe(85000);
  });

  it("rejects a discount that would make the charge negative", () => {
    expect(() => computeLineNetAmountMinor(1, 10000, 20000)).toThrow();
  });
});
