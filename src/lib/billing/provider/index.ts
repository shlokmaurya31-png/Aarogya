import type { BillingProviderKind } from "@prisma/client";
import type { BillingProvider } from "./types";
import { FakeBillingProvider } from "./fake";

export type { BillingProvider, NormalizedWebhookEvent, ProviderPaymentResult, ProviderRefundResult } from "./types";
export { FakeBillingProvider, fakeSign } from "./fake";

/**
 * Provider selection.
 *
 * The configured provider is read from BILLING_PROVIDER and defaults to NONE —
 * this repository has NO real payment provider integrated. `getProvider` returns
 * a concrete implementation only for FAKE (deterministic tests); requesting a
 * provider while none is configured throws, so no code silently pretends a
 * gateway exists. When a real provider is genuinely onboarded, add its
 * implementation here and map its kind — never fake production connectivity.
 */
export function configuredProviderKind(): BillingProviderKind {
  const raw = (process.env.BILLING_PROVIDER ?? "NONE").toUpperCase();
  return raw === "FAKE" ? "FAKE" : "NONE";
}

export function getProvider(kind: BillingProviderKind): BillingProvider {
  switch (kind) {
    case "FAKE":
      return new FakeBillingProvider();
    case "NONE":
    default:
      throw new Error("No payment provider is configured. Set BILLING_PROVIDER, or use manual/out-of-band recording.");
  }
}

/** True when a real (non-NONE, non-FAKE) provider is configured. Always false today. */
export function hasRealProvider(): boolean {
  return false;
}
