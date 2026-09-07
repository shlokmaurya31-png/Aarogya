import { describe, it, expect } from "vitest";
import { isLotEligible, compareLotsForFefo, type FefoCandidate } from "./fefo";

const lot = (overrides: Partial<FefoCandidate>): FefoCandidate => ({
  lotId: "lot-1",
  lotStatus: "ACTIVE",
  expiresAt: null,
  onHandQty: 100,
  reservedQty: 0,
  ...overrides,
});

describe("isLotEligible — never issues expired or quarantined stock", () => {
  it("an ACTIVE, non-expired lot with enough available is eligible", () => {
    expect(isLotEligible(lot({}), 10)).toBe(true);
  });

  it("a QUARANTINED lot is never eligible, even with plenty of stock", () => {
    expect(isLotEligible(lot({ lotStatus: "QUARANTINED" }), 10)).toBe(false);
  });

  it("an EXPIRED lot (by status) is never eligible", () => {
    expect(isLotEligible(lot({ lotStatus: "EXPIRED" }), 10)).toBe(false);
  });

  it("a lot whose expiresAt has passed is never eligible, even if status still says ACTIVE (lazy-flip not yet applied)", () => {
    expect(isLotEligible(lot({ expiresAt: new Date(Date.now() - 86_400_000) }), 10)).toBe(false);
  });

  it("a lot expiring in the future is eligible", () => {
    expect(isLotEligible(lot({ expiresAt: new Date(Date.now() + 86_400_000) }), 10)).toBe(true);
  });

  it("a lot with insufficient available (onHand - reserved) is not eligible", () => {
    expect(isLotEligible(lot({ onHandQty: 5, reservedQty: 0 }), 10)).toBe(false);
  });

  it("reserved quantity reduces available below the requested amount", () => {
    expect(isLotEligible(lot({ onHandQty: 10, reservedQty: 5 }), 8)).toBe(false);
  });
});

describe("compareLotsForFefo — earliest expiry first, deterministic tiebreak", () => {
  it("a lot expiring sooner sorts before one expiring later", () => {
    const soon = lot({ lotId: "a", expiresAt: new Date("2026-06-01") });
    const later = lot({ lotId: "b", expiresAt: new Date("2026-12-01") });
    expect(compareLotsForFefo(soon, later)).toBeLessThan(0);
    expect(compareLotsForFefo(later, soon)).toBeGreaterThan(0);
  });

  it("a never-expiring lot (null expiresAt) sorts after any lot with a real expiry date", () => {
    const neverExpires = lot({ lotId: "a", expiresAt: null });
    const hasExpiry = lot({ lotId: "b", expiresAt: new Date("2099-01-01") });
    expect(compareLotsForFefo(neverExpires, hasExpiry)).toBeGreaterThan(0);
  });

  it("equal expiry dates break the tie deterministically on lotId", () => {
    const sameDate = new Date("2026-06-01");
    const a = lot({ lotId: "aaa", expiresAt: sameDate });
    const b = lot({ lotId: "bbb", expiresAt: sameDate });
    expect(compareLotsForFefo(a, b)).toBeLessThan(0);
    expect(compareLotsForFefo(b, a)).toBeGreaterThan(0);
  });

  it("two lots with no expiry at all still break the tie deterministically on lotId", () => {
    const a = lot({ lotId: "aaa", expiresAt: null });
    const b = lot({ lotId: "bbb", expiresAt: null });
    expect(compareLotsForFefo(a, b)).toBeLessThan(0);
  });
});
