import { createHmac, timingSafeEqual } from "node:crypto";
import type { BillingProvider, NormalizedWebhookEvent, ProviderPaymentResult, ProviderRefundResult } from "./types";
import type { HttpTransport } from "./http";
import { fetchTransport } from "./http";
import { getRazorpayConfig, ProviderConfigError, type RazorpayConfig } from "./config";

/**
 * Phase D4 — Razorpay adapter (India-first). Implements the official Razorpay
 * REST contract (Orders, Payments, Refunds, Customers) and the documented webhook
 * signature scheme (HMAC-SHA256 hex of the raw body with the webhook secret).
 *
 * IMPORTANT HONESTY: this is real, contract-accurate code, but no Razorpay
 * credentials exist in this repository. It is therefore ADAPTER VERIFIED
 * (request-building, response-normalization, error-mapping and signature logic
 * unit-tested with an injected transport and a known secret) but NOT sandbox- or
 * production-verified — no live call has ever been made. The HTTP transport is
 * injected so the logic is testable offline; production simply wires `fetch`.
 *
 * Razorpay's payment flow is asynchronous: the server creates an ORDER (the
 * request reference); the customer pays via checkout; a `payment.captured`
 * webhook (or an explicit fetch) confirms the actual PAYMENT. So createPayment
 * returns status "pending" with the order id as providerRequestRef — the payment
 * is recorded only once captured. Amounts are paise (Razorpay's minor unit for
 * INR), matching Aarogya's minor units.
 */

/** Razorpay payment.status -> Aarogya normalized status. */
function normalizePaymentStatus(s: string | undefined): "succeeded" | "failed" | "pending" {
  switch (s) {
    case "captured": return "succeeded";
    case "failed": return "failed";
    case "created":
    case "authorized":
    case "refunded":     // a refunded payment did succeed; refund state is tracked separately
    default: return s === "refunded" ? "succeeded" : "pending";
  }
}

export class RazorpayBillingProvider implements BillingProvider {
  readonly kind = "RAZORPAY" as const;
  private cfg: RazorpayConfig;
  private http: HttpTransport;

  constructor(cfg?: RazorpayConfig, http: HttpTransport = fetchTransport) {
    this.cfg = cfg ?? getRazorpayConfig();
    this.http = http;
  }

  private authHeader(): string {
    const token = Buffer.from(`${this.cfg.keyId}:${this.cfg.keySecret}`).toString("base64");
    return `Basic ${token}`;
  }

  private async call(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await this.http({
      method,
      url: `${this.cfg.baseUrl}${path}`,
      headers: { Authorization: this.authHeader(), "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    let parsed: Record<string, unknown> = {};
    try { parsed = res.body ? JSON.parse(res.body) : {}; } catch { parsed = {}; }
    if (res.status >= 400) {
      const err = (parsed.error ?? {}) as { code?: string; description?: string };
      throw new ProviderConfigError(`Razorpay API error ${res.status}: ${err.code ?? "unknown"} ${err.description ?? ""}`.trim());
    }
    return parsed;
  }

  async createCustomer(input: { organizationId: string; billingName: string; billingEmail: string }): Promise<{ providerCustomerRef: string }> {
    const r = await this.call("POST", "/customers", {
      name: input.billingName || input.organizationId,
      email: input.billingEmail || undefined,
      fail_existing: 0, // idempotent-ish: return the existing customer instead of erroring
      notes: { organizationId: input.organizationId },
    });
    return { providerCustomerRef: String(r.id) };
  }

  async createPayment(input: { amountMinor: number; currency: string; idempotencyKey: string; providerCustomerRef?: string | null }): Promise<ProviderPaymentResult> {
    // Create an ORDER to collect the payment. receipt carries our idempotency key
    // so a retried creation maps to the same logical order on our side.
    const r = await this.call("POST", "/orders", {
      amount: input.amountMinor,
      currency: input.currency,
      receipt: input.idempotencyKey,
      notes: input.providerCustomerRef ? { customerRef: input.providerCustomerRef } : undefined,
    });
    return { providerRequestRef: String(r.id), status: "pending" };
  }

  async retrievePayment(providerPaymentRef: string): Promise<ProviderPaymentResult | null> {
    try {
      const r = await this.call("GET", `/payments/${providerPaymentRef}`);
      if (!r.id) return null;
      return {
        providerPaymentRef: String(r.id),
        providerRequestRef: r.order_id ? String(r.order_id) : undefined,
        status: normalizePaymentStatus(r.status as string | undefined),
        failureCode: r.error_code ? String(r.error_code) : undefined,
      };
    } catch {
      return null;
    }
  }

  async refundPayment(input: { providerPaymentRef: string; amountMinor: number; idempotencyKey: string }): Promise<ProviderRefundResult> {
    const r = await this.call("POST", `/payments/${input.providerPaymentRef}/refund`, {
      amount: input.amountMinor,
      // Razorpay honours an idempotency key via a header on the standard SDK; on
      // the raw API the receipt-like notes + our own idempotency guard protect us.
      notes: { idempotencyKey: input.idempotencyKey },
    });
    const status = r.status === "failed" ? "failed" : "succeeded";
    return { providerRefundRef: String(r.id), status };
  }

  verifyWebhook(input: { payload: string; signature: string }): boolean {
    const expected = createHmac("sha256", this.cfg.webhookSecret).update(input.payload).digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(input.signature || "");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  parseWebhook(payload: string, eventIdHint?: string): NormalizedWebhookEvent {
    const obj = JSON.parse(payload) as {
      event?: string;
      created_at?: number;
      payload?: { payment?: { entity?: { id?: string; order_id?: string; amount?: number; status?: string; error_code?: string } }; refund?: { entity?: { id?: string; payment_id?: string; amount?: number; status?: string } } };
    };
    if (!obj.event) throw new Error("Malformed Razorpay webhook: missing event.");
    const pay = obj.payload?.payment?.entity;
    const rfnd = obj.payload?.refund?.entity;
    // Razorpay's stable delivery id is the X-Razorpay-Event-Id header. Fall back to
    // a deterministic id derived from the resource so replays still dedupe.
    const externalEventId = eventIdHint || `${obj.event}:${pay?.id ?? rfnd?.id ?? "unknown"}`;
    return {
      externalEventId,
      eventType: obj.event,
      providerPaymentRef: pay?.id ?? rfnd?.payment_id,
      providerResourceRef: pay?.order_id,
      paymentStatus: pay ? normalizePaymentStatus(pay.status) : undefined,
      amountMinor: pay?.amount ?? rfnd?.amount,
      createdAtUnix: obj.created_at,
      failureCode: pay?.error_code,
    };
  }
}
