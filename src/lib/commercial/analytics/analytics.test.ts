import { describe, it, expect } from "vitest";
import { invoiceOutstandingMinor, CurrencyBuckets, resolvePeriod, safeRate, toCsv } from "./shared";
import { deriveCollectionState } from "./collections";
import { categorizeFailure } from "./failures";

/**
 * Phase D5 — pure, data-independent rules. DB-backed behaviour (aggregates, tenant
 * isolation, concurrency) is proven by scripts/verify-postgres-d5-commercial.ts.
 */

describe("authoritative outstanding", () => {
  it("is total minus paid for open states, zero for terminal, never negative", () => {
    expect(invoiceOutstandingMinor({ status: "OPEN", totalMinor: 1000, amountPaidMinor: 300 })).toBe(700);
    expect(invoiceOutstandingMinor({ status: "PARTIALLY_PAID", totalMinor: 1000, amountPaidMinor: 1000 })).toBe(0);
    expect(invoiceOutstandingMinor({ status: "PAID", totalMinor: 1000, amountPaidMinor: 0 })).toBe(0);
    expect(invoiceOutstandingMinor({ status: "VOID", totalMinor: 1000, amountPaidMinor: 0 })).toBe(0);
    expect(invoiceOutstandingMinor({ status: "DRAFT", totalMinor: 1000, amountPaidMinor: 0 })).toBe(0);
    expect(invoiceOutstandingMinor({ status: "OPEN", totalMinor: 1000, amountPaidMinor: 1500 })).toBe(0);
  });
});

describe("currency buckets", () => {
  it("never combines currencies and preserves ensured dimensions", () => {
    const b = new CurrencyBuckets();
    b.add("INR", 100); b.add("INR", 50); b.add("USD", 200); b.ensure("EUR");
    expect(b.toArray()).toEqual([{ currency: "EUR", amountMinor: 0 }, { currency: "INR", amountMinor: 150 }, { currency: "USD", amountMinor: 200 }]);
  });
});

describe("period bounds", () => {
  it("defaults, clamps to maxDays and orders from<=to", () => {
    const now = new Date("2026-06-30T00:00:00Z");
    const def = resolvePeriod(undefined, undefined, { now });
    expect(def.days).toBe(30);
    const clamped = resolvePeriod("2000-01-01", "2026-06-30", { now, maxDays: 400 });
    expect(clamped.days).toBeLessThanOrEqual(400);
    const swapped = resolvePeriod("2026-06-30", "2026-06-01", { now });
    expect(swapped.from <= swapped.to).toBe(true);
  });
});

describe("safe rate", () => {
  it("returns null when denominator is zero", () => {
    expect(safeRate(0, 0).rate).toBeNull();
    expect(safeRate(1, 4).rate).toBe(0.25);
  });
});

describe("collection state derivation", () => {
  const now = new Date("2026-06-01T00:00:00Z");
  it("derives from commercial state + overdue", () => {
    expect(deriveCollectionState(null, false, now)).toBe("NORMAL");
    expect(deriveCollectionState({ status: "ACTIVE", gracePeriodEndsAt: null }, false, now)).toBe("NORMAL");
    expect(deriveCollectionState({ status: "ACTIVE", gracePeriodEndsAt: null }, true, now)).toBe("ATTENTION");
    expect(deriveCollectionState({ status: "PAST_DUE", gracePeriodEndsAt: null }, true, now)).toBe("PAST_DUE");
    expect(deriveCollectionState({ status: "SUSPENDED", gracePeriodEndsAt: null }, true, now)).toBe("SUSPENDED");
    expect(deriveCollectionState({ status: "GRACE", gracePeriodEndsAt: new Date("2026-07-01") }, true, now)).toBe("GRACE");
    expect(deriveCollectionState({ status: "GRACE", gracePeriodEndsAt: new Date("2026-06-02") }, true, now)).toBe("SUSPENSION_RISK");
  });
});

describe("failure categorization (no false causes)", () => {
  it("maps only what the code indicates; unknown stays unknown", () => {
    expect(categorizeFailure("insufficient_funds")).toBe("INSUFFICIENT_FUNDS");
    expect(categorizeFailure("card_declined")).toBe("PROVIDER_DECLINE");
    expect(categorizeFailure("BAD_REQUEST_ERROR")).toBe("CONFIGURATION_ERROR");
    expect(categorizeFailure("authentication_required")).toBe("CUSTOMER_ACTION_REQUIRED");
    expect(categorizeFailure("gateway_error")).toBe("NETWORK_ERROR");
    expect(categorizeFailure(null)).toBe("UNKNOWN_PROVIDER_ERROR");
    expect(categorizeFailure("something_weird")).toBe("UNKNOWN_PROVIDER_ERROR");
  });
});

describe("csv", () => {
  it("escapes commas, quotes and newlines", () => {
    const csv = toCsv(["a", "b"], [{ a: "x,y", b: 'he said "hi"' }, { a: "l1\nl2", b: 1 }]);
    expect(csv).toBe('a,b\n"x,y","he said ""hi"""\n"l1\nl2",1\n');
  });
});
