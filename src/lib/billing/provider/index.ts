import type { BillingProviderKind } from "@prisma/client";
import type { BillingProvider } from "./types";
import { FakeBillingProvider } from "./fake";
import { RazorpayBillingProvider } from "./razorpay";
import { isProviderConfigured } from "./config";

export type { BillingProvider, NormalizedWebhookEvent, ProviderPaymentResult, ProviderRefundResult } from "./types";
export { FakeBillingProvider, fakeSign } from "./fake";
export { RazorpayBillingProvider } from "./razorpay";
export { ProviderConfigError, isProviderConfigured, getRazorpayConfig } from "./config";

/**
 * Provider selection (Phase D4).
 *
 * The configured provider is read from BILLING_PROVIDER and defaults to NONE.
 * `getProvider` returns a concrete adapter for FAKE (deterministic tests) and
 * RAZORPAY (the real adapter — but it throws a ProviderConfigError if Razorpay
 * credentials are absent, which they are in this repository). Requesting a
 * provider while NONE is configured throws, so no code silently pretends a
 * gateway exists. Real production connectivity requires configuring credentials
 * in the environment; it is never faked.
 */
export function configuredProviderKind(): BillingProviderKind {
  const raw = (process.env.BILLING_PROVIDER ?? "NONE").toUpperCase();
  if (raw === "FAKE") return "FAKE";
  if (raw === "RAZORPAY") return "RAZORPAY";
  return "NONE";
}

export function getProvider(kind: BillingProviderKind): BillingProvider {
  switch (kind) {
    case "FAKE":
      return new FakeBillingProvider();
    case "RAZORPAY":
      return new RazorpayBillingProvider(); // throws ProviderConfigError if unconfigured
    case "NONE":
    default:
      throw new Error("No payment provider is configured. Set BILLING_PROVIDER, or use manual/out-of-band recording.");
  }
}

/**
 * True only when a REAL provider is both selected and actually configured with
 * credentials. Always false in this repository (no credentials). Used for honest
 * status reporting — never to gate faked connectivity.
 */
export function hasRealProvider(): boolean {
  const kind = configuredProviderKind();
  return kind === "RAZORPAY" && isProviderConfigured(kind);
}
