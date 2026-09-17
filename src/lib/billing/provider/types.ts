import type { BillingProviderKind } from "@prisma/client";

/**
 * Phase D3 — the payment-provider BOUNDARY.
 *
 * Aarogya owns all domain state (subscriptions, invoices, payments, refunds,
 * reconciliation); a provider only EXECUTES payment and returns OPAQUE references
 * that map back onto Aarogya records. Provider SDK objects must never become
 * persisted domain models — only the refs and normalized results below cross this
 * line. No provider secret is ever stored in the database.
 *
 * No real provider is integrated in this repository. The only implementation is a
 * deterministic in-repo FAKE used by the verification gate; real providers are
 * added here when genuinely onboarded, never faked.
 */

export type ProviderPaymentStatus = "succeeded" | "failed" | "pending";

export interface ProviderPaymentResult {
  providerPaymentRef: string;
  status: ProviderPaymentStatus;
  failureReason?: string;
}

export interface ProviderRefundResult {
  providerRefundRef: string;
  status: "succeeded" | "failed";
  failureReason?: string;
}

/** A provider webhook, already parsed into a normalized, provider-agnostic shape. */
export interface NormalizedWebhookEvent {
  externalEventId: string;
  eventType: string;
  /** Opaque provider payment reference the event concerns, if any. */
  providerPaymentRef?: string;
  /** Normalized outcome for payment events. */
  paymentStatus?: ProviderPaymentStatus;
}

export interface BillingProvider {
  readonly kind: BillingProviderKind;

  createCustomer(input: { organizationId: string; billingName: string; billingEmail: string }): Promise<{ providerCustomerRef: string }>;

  createPayment(input: {
    amountMinor: number;
    currency: string;
    idempotencyKey: string;
    providerCustomerRef?: string | null;
  }): Promise<ProviderPaymentResult>;

  retrievePayment(providerPaymentRef: string): Promise<ProviderPaymentResult | null>;

  refundPayment(input: { providerPaymentRef: string; amountMinor: number; idempotencyKey: string }): Promise<ProviderRefundResult>;

  /** Authenticity check — returns true only if the signature matches the payload. */
  verifyWebhook(input: { payload: string; signature: string }): boolean;

  /** Parse a verified payload into the normalized shape. Throws on malformed input. */
  parseWebhook(payload: string): NormalizedWebhookEvent;
}
