import { describe, it, expect } from "vitest";
import { roundHalfUp, applyRateBps, sumMinor } from "./money";
import { computeTaxMinor, resolveTaxRateBps } from "./tax";
import { computeTotals } from "./invoices";
import { canTransitionInvoice, isInvoiceMutable, isInvoicePayable } from "./constants";
import { PLAN_PRICES } from "./pricing";
import { formatInvoiceNumber } from "./sequence";
import { FakeBillingProvider, fakeSign } from "./provider/fake";

/**
 * Phase D3 — rules that hold regardless of data. Runtime behaviour against a real
 * database (idempotency, limit/over-payment races, cross-tenant isolation, webhook
 * exactly-once) is proven by scripts/verify-postgres-saas-billing.ts.
 */

describe("money", () => {
  it("rounds half up, once", () => {
    expect(roundHalfUp(0.5)).toBe(1);
    expect(roundHalfUp(1.49)).toBe(1);
    expect(applyRateBps(499_900, 1800)).toBe(89_982); // 18% of ₹4,999.00
    expect(applyRateBps(1000, 0)).toBe(0);
    expect(sumMinor([100, 200, 300])).toBe(600);
  });
});

describe("tax boundary", () => {
  it("resolves known codes and treats unknown as zero (no unsupported claim)", () => {
    expect(resolveTaxRateBps("GST_18")).toBe(1800);
    expect(resolveTaxRateBps("MADE_UP")).toBe(0);
    expect(resolveTaxRateBps(null)).toBe(0);
    expect(computeTaxMinor(499_900, "GST_18")).toEqual({ taxAmountMinor: 89_982, rateBps: 1800 });
    expect(computeTaxMinor(499_900, null)).toEqual({ taxAmountMinor: 0, rateBps: 0 });
  });
});

describe("invoice totals", () => {
  it("sums charges + tax, subtracts credits, never negative", () => {
    const t = computeTotals([
      { type: "SUBSCRIPTION", amountMinor: 499_900, taxAmountMinor: 89_982 },
    ]);
    expect(t).toEqual({ subtotalMinor: 499_900, discountMinor: 0, taxMinor: 89_982, totalMinor: 589_882 });

    const withCredit = computeTotals([
      { type: "SUBSCRIPTION", amountMinor: 499_900, taxAmountMinor: 89_982 },
      { type: "CREDIT", amountMinor: -100_000, taxAmountMinor: 0 },
    ]);
    expect(withCredit.discountMinor).toBe(100_000);
    expect(withCredit.totalMinor).toBe(489_882);

    const overCredited = computeTotals([
      { type: "SUBSCRIPTION", amountMinor: 10_000, taxAmountMinor: 0 },
      { type: "CREDIT", amountMinor: -50_000, taxAmountMinor: 0 },
    ]);
    expect(overCredited.totalMinor).toBe(0); // clamped, never negative
  });
});

describe("invoice lifecycle", () => {
  it("allows only declared transitions and freezes non-draft invoices", () => {
    expect(canTransitionInvoice("DRAFT", "OPEN")).toBe(true);
    expect(canTransitionInvoice("OPEN", "PAID")).toBe(true);
    expect(canTransitionInvoice("PAID", "OPEN")).toBe(false);
    expect(canTransitionInvoice("VOID", "OPEN")).toBe(false);
    expect(isInvoiceMutable("DRAFT")).toBe(true);
    expect(isInvoiceMutable("OPEN")).toBe(false);
    expect(isInvoicePayable("OPEN")).toBe(true);
    expect(isInvoicePayable("PAID")).toBe(false);
  });
});

describe("pricing registry", () => {
  it("prices the sold plans and never the grandfather plan", () => {
    const codes = PLAN_PRICES.map((p) => p.planCode);
    expect(codes).toContain("starter");
    expect(codes).toContain("professional");
    expect(codes).toContain("enterprise");
    expect(codes).not.toContain("aarogya-default");
    for (const p of PLAN_PRICES) expect(p.amountMinor).toBeGreaterThan(0);
  });
});

describe("invoice numbering", () => {
  it("is deterministic and zero-padded", () => {
    expect(formatInvoiceNumber(2026, 42)).toBe("AAR-SAAS-2026-000042");
  });
});

describe("fake provider (deterministic boundary)", () => {
  const p = new FakeBillingProvider();
  it("verifies a valid signature and rejects a tampered payload", () => {
    const payload = JSON.stringify({ id: "evt_1", type: "payment.succeeded" });
    expect(p.verifyWebhook({ payload, signature: fakeSign(payload) })).toBe(true);
    expect(p.verifyWebhook({ payload, signature: fakeSign(payload + "x") })).toBe(false);
    expect(p.verifyWebhook({ payload: payload + "tampered", signature: fakeSign(payload) })).toBe(false);
  });
  it("parses events and models forced failure", async () => {
    const ev = p.parseWebhook(JSON.stringify({ id: "evt_2", type: "payment.succeeded", providerPaymentRef: "fake_pay_x" }));
    expect(ev.externalEventId).toBe("evt_2");
    expect((await p.createPayment({ amountMinor: 100, idempotencyKey: "ok" })).status).toBe("succeeded");
    expect((await p.createPayment({ amountMinor: 100, idempotencyKey: "FORCE_FAIL" })).status).toBe("failed");
  });
});
