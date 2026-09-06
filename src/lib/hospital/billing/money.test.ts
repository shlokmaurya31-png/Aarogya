import { describe, it, expect } from "vitest";
import {
  rupeesToMinor,
  minorToRupees,
  roundHalfUp,
  applyPercentDiscount,
  computeLineGrossAmountMinor,
  computeLineNetAmountMinor,
  sumMinor,
  ceilStayDays,
} from "./money";

describe("rupeesToMinor / minorToRupees — round-trip", () => {
  it("converts ₹100.50 to 10050 paise", () => {
    expect(rupeesToMinor(100.5)).toBe(10050);
  });

  it("round-trips exactly for a value with no fractional paise", () => {
    expect(minorToRupees(rupeesToMinor(1500))).toBe(1500);
  });

  it("rounds a sub-paise rupee value rather than truncating (avoids silent underbilling)", () => {
    expect(rupeesToMinor(10.005)).toBe(1001); // 1000.5 -> 1001, not 1000
  });
});

describe("roundHalfUp", () => {
  it("rounds exactly-half values up, not to even (no banker's rounding surprises in a billing system)", () => {
    expect(roundHalfUp(0.5)).toBe(1);
    expect(roundHalfUp(1.5)).toBe(2);
    expect(roundHalfUp(2.5)).toBe(3);
  });

  it("leaves whole numbers unchanged", () => {
    expect(roundHalfUp(42)).toBe(42);
  });
});

describe("applyPercentDiscount", () => {
  it("computes a percentage discount on an odd-paise amount without drifting", () => {
    expect(applyPercentDiscount(999, 10)).toBe(100); // 99.9 -> 100
  });

  it("rejects a negative percent", () => {
    expect(() => applyPercentDiscount(1000, -5)).toThrow();
  });

  it("rejects a percent over 100", () => {
    expect(() => applyPercentDiscount(1000, 150)).toThrow();
  });
});

describe("computeLineGrossAmountMinor — quantity x unit price", () => {
  it("handles a fractional quantity (e.g. 1.5 bed-days) without float drift in the final integer", () => {
    expect(computeLineGrossAmountMinor(1.5, 200000)).toBe(300000);
  });

  it("handles quantity=1 (the common case)", () => {
    expect(computeLineGrossAmountMinor(1, 50000)).toBe(50000);
  });
});

describe("computeLineNetAmountMinor", () => {
  it("subtracts a valid discount from the gross amount", () => {
    expect(computeLineNetAmountMinor(1, 100000, 10000)).toBe(90000);
  });

  it("rejects a discount larger than the gross line amount (no negative-amount charge)", () => {
    expect(() => computeLineNetAmountMinor(1, 1000, 5000)).toThrow();
  });

  it("rejects a negative discount", () => {
    expect(() => computeLineNetAmountMinor(1, 1000, -100)).toThrow();
  });
});

describe("ceilStayDays — bed accommodation billing day-count", () => {
  const d = (s: string) => new Date(s);

  it("counts a same-day admission/discharge as 1 day minimum, never 0", () => {
    expect(ceilStayDays(d("2027-01-01T10:00:00Z"), d("2027-01-01T14:00:00Z"))).toBe(1);
  });

  it("counts an exact 24-hour stay as 1 day", () => {
    expect(ceilStayDays(d("2027-01-01T10:00:00Z"), d("2027-01-02T10:00:00Z"))).toBe(1);
  });

  it("rounds a stay one minute over 24 hours up to 2 days (any partial day counts as a full day)", () => {
    expect(ceilStayDays(d("2027-01-01T10:00:00Z"), d("2027-01-02T10:01:00Z"))).toBe(2);
  });

  it("counts an exact 3-day stay as 3 days", () => {
    expect(ceilStayDays(d("2027-01-01T00:00:00Z"), d("2027-01-04T00:00:00Z"))).toBe(3);
  });

  it("rounds a stay just under a whole-day boundary up (e.g. 2 days 23h59m -> 3 days)", () => {
    expect(ceilStayDays(d("2027-01-01T00:00:00Z"), d("2027-01-03T23:59:00Z"))).toBe(3);
  });
});

describe("sumMinor", () => {
  it("sums an array of minor-unit amounts exactly (no float accumulation error)", () => {
    expect(sumMinor([100000, 200000, 300000, 1])).toBe(600001);
  });

  it("returns 0 for an empty array", () => {
    expect(sumMinor([])).toBe(0);
  });
});
