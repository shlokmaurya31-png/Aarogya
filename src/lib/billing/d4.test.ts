import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { canTransitionAttempt, canTransitionPayment, attemptStatusForProvider } from "./paymentState";
import { isProviderConfigured } from "./provider/config";
import { RazorpayBillingProvider } from "./provider/razorpay";
import type { HttpRequest, HttpResponse, HttpTransport } from "./provider/http";
import type { RazorpayConfig } from "./provider/config";

/**
 * Phase D4 — ADAPTER-VERIFIED tests. The Razorpay adapter's request-building,
 * response-normalization, error-mapping and signature logic are verified with an
 * injected transport and a known secret — no network, no real credentials. This
 * is NOT sandbox or production verification (no live call is ever made).
 */

const CFG: RazorpayConfig = {
  keyId: "rzp_test_key", keySecret: "secret", webhookSecret: "whsec", baseUrl: "https://api.razorpay.example/v1", webhookToleranceSeconds: 300,
};

function transportReturning(map: (req: HttpRequest) => HttpResponse): { transport: HttpTransport; last: () => HttpRequest | null } {
  let last: HttpRequest | null = null;
  const transport: HttpTransport = async (req) => { last = req; return map(req); };
  return { transport, last: () => last };
}

describe("payment state machine", () => {
  it("permits only safe transitions", () => {
    expect(canTransitionAttempt("INITIATED", "SUCCEEDED")).toBe(true);
    expect(canTransitionAttempt("PENDING", "FAILED")).toBe(true);
    expect(canTransitionAttempt("SUCCEEDED", "FAILED")).toBe(false);
    expect(canTransitionAttempt("FAILED", "SUCCEEDED")).toBe(false);
    expect(canTransitionPayment("SUCCEEDED", "REFUNDED")).toBe(true);
    expect(canTransitionPayment("REFUNDED", "SUCCEEDED")).toBe(false);
    expect(canTransitionPayment("SUCCEEDED", "SUCCEEDED" as never)).toBe(false);
    expect(attemptStatusForProvider("succeeded")).toBe("SUCCEEDED");
    expect(attemptStatusForProvider("pending")).toBe("PENDING");
  });
});

describe("provider config", () => {
  it("treats NONE/FAKE as configured and RAZORPAY as unconfigured without creds", () => {
    expect(isProviderConfigured("NONE")).toBe(true);
    expect(isProviderConfigured("FAKE")).toBe(true);
    // No RAZORPAY_* env in tests -> not configured (honest).
    expect(isProviderConfigured("RAZORPAY")).toBe(false);
  });
});

describe("Razorpay adapter (injected transport)", () => {
  it("creates a customer with basic auth and returns the opaque ref", async () => {
    const { transport, last } = transportReturning(() => ({ status: 200, body: JSON.stringify({ id: "cust_abc" }) }));
    const p = new RazorpayBillingProvider(CFG, transport);
    const r = await p.createCustomer({ organizationId: "org1", billingName: "Org One", billingEmail: "a@b.co" });
    expect(r.providerCustomerRef).toBe("cust_abc");
    expect(last()!.url).toBe("https://api.razorpay.example/v1/customers");
    expect(last()!.headers.Authorization).toMatch(/^Basic /);
  });

  it("creates an order for a payment and reports pending with the order ref", async () => {
    const { transport, last } = transportReturning(() => ({ status: 200, body: JSON.stringify({ id: "order_xyz", status: "created" }) }));
    const p = new RazorpayBillingProvider(CFG, transport);
    const r = await p.createPayment({ amountMinor: 2_949_882, currency: "INR", idempotencyKey: "renew:1" });
    expect(r.status).toBe("pending");
    expect(r.providerRequestRef).toBe("order_xyz");
    expect(last()!.url).toContain("/orders");
    expect(JSON.parse(last()!.body!).amount).toBe(2_949_882);
  });

  it("normalizes payment retrieval statuses", async () => {
    const mk = (status: string) => new RazorpayBillingProvider(CFG, transportReturning(() => ({ status: 200, body: JSON.stringify({ id: "pay_1", order_id: "order_1", status }) })).transport);
    expect((await mk("captured").retrievePayment("pay_1"))!.status).toBe("succeeded");
    expect((await mk("failed").retrievePayment("pay_1"))!.status).toBe("failed");
    expect((await mk("authorized").retrievePayment("pay_1"))!.status).toBe("pending");
  });

  it("maps API errors to a deterministic error", async () => {
    const p = new RazorpayBillingProvider(CFG, transportReturning(() => ({ status: 400, body: JSON.stringify({ error: { code: "BAD_REQUEST_ERROR", description: "nope" } }) })).transport);
    await expect(p.createCustomer({ organizationId: "o", billingName: "n", billingEmail: "" })).rejects.toThrow(/Razorpay API error 400/);
  });

  it("verifies a valid webhook signature and rejects a tampered one", () => {
    const p = new RazorpayBillingProvider(CFG, transportReturning(() => ({ status: 200, body: "{}" })).transport);
    const payload = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_9", order_id: "order_9", amount: 100, status: "captured" } } } });
    const sig = createHmac("sha256", CFG.webhookSecret).update(payload).digest("hex");
    expect(p.verifyWebhook({ payload, signature: sig })).toBe(true);
    expect(p.verifyWebhook({ payload, signature: sig.replace(/.$/, "0") })).toBe(false);
    expect(p.verifyWebhook({ payload: payload + " ", signature: sig })).toBe(false);
  });

  it("normalizes a captured webhook, using the header event id", () => {
    const p = new RazorpayBillingProvider(CFG, transportReturning(() => ({ status: 200, body: "{}" })).transport);
    const payload = JSON.stringify({ event: "payment.captured", created_at: 1700000000, payload: { payment: { entity: { id: "pay_9", order_id: "order_9", amount: 500, status: "captured" } } } });
    const ev = p.parseWebhook(payload, "evt_header_id");
    expect(ev.externalEventId).toBe("evt_header_id");
    expect(ev.eventType).toBe("payment.captured");
    expect(ev.providerPaymentRef).toBe("pay_9");
    expect(ev.providerResourceRef).toBe("order_9");
    expect(ev.paymentStatus).toBe("succeeded");
    expect(ev.amountMinor).toBe(500);
  });
});
