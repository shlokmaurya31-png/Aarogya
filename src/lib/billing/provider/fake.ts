import { createHmac, timingSafeEqual } from "node:crypto";
import type { BillingProvider, NormalizedWebhookEvent, ProviderPaymentResult, ProviderRefundResult } from "./types";

/**
 * Phase D3 — deterministic in-repo FAKE provider.
 *
 * Exists ONLY so the domain and the provider boundary can be verified
 * deterministically, offline, with no network and no real credentials. It is NOT
 * a real gateway and makes NO external call. Behaviour is fully deterministic:
 *
 *  - createPayment succeeds, unless the idempotencyKey contains "FORCE_FAIL"
 *    (so the failed-payment lifecycle can be exercised).
 *  - webhook signatures are HMAC-SHA256 over the payload with a fixed TEST secret,
 *    so verifyWebhook exercises real signature logic (accept valid, reject
 *    tampered) without pretending to talk to anyone.
 *
 * This secret is a TEST constant, never a production credential.
 */
const FAKE_TEST_SECRET = "aarogya-fake-provider-test-secret";

export function fakeSign(payload: string): string {
  return createHmac("sha256", FAKE_TEST_SECRET).update(payload).digest("hex");
}

export class FakeBillingProvider implements BillingProvider {
  readonly kind = "FAKE" as const;

  async createCustomer(input: { organizationId: string }): Promise<{ providerCustomerRef: string }> {
    return { providerCustomerRef: `fake_cust_${input.organizationId}` };
  }

  async createPayment(input: { amountMinor: number; idempotencyKey: string }): Promise<ProviderPaymentResult> {
    const ref = `fake_pay_${input.idempotencyKey}`;
    if (input.idempotencyKey.includes("FORCE_FAIL")) {
      return { providerPaymentRef: ref, status: "failed", failureReason: "card_declined" };
    }
    return { providerPaymentRef: ref, status: "succeeded" };
  }

  async retrievePayment(providerPaymentRef: string): Promise<ProviderPaymentResult | null> {
    if (!providerPaymentRef.startsWith("fake_pay_")) return null;
    const status = providerPaymentRef.includes("FORCE_FAIL") ? "failed" : "succeeded";
    return { providerPaymentRef, status };
  }

  async refundPayment(input: { providerPaymentRef: string; idempotencyKey: string }): Promise<ProviderRefundResult> {
    return { providerRefundRef: `fake_rfnd_${input.idempotencyKey}`, status: "succeeded" };
  }

  verifyWebhook(input: { payload: string; signature: string }): boolean {
    const expected = fakeSign(input.payload);
    const a = Buffer.from(expected);
    const b = Buffer.from(input.signature);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  parseWebhook(payload: string): NormalizedWebhookEvent {
    const obj = JSON.parse(payload) as {
      id?: string; type?: string; providerPaymentRef?: string; paymentStatus?: "succeeded" | "failed" | "pending";
    };
    if (!obj.id || !obj.type) throw new Error("Malformed webhook payload: missing id/type.");
    return {
      externalEventId: obj.id,
      eventType: obj.type,
      providerPaymentRef: obj.providerPaymentRef,
      paymentStatus: obj.paymentStatus,
    };
  }
}
