# Payment provider boundary (Phase D3)

Aarogya owns the domain state (subscriptions, invoices, payments, refunds,
reconciliation). A provider only EXECUTES payment and returns OPAQUE references
that map back onto Aarogya records. Provider SDK objects never become persisted
domain models; only refs and normalized results cross the line. No provider
secret is ever stored in the database.

## The interface

`BillingProvider` (`src/lib/billing/provider/types.ts`): `createCustomer`,
`createPayment`, `retrievePayment`, `refundPayment`, `verifyWebhook`,
`parseWebhook`. Results are a normalized `ProviderPaymentResult` /
`ProviderRefundResult` / `NormalizedWebhookEvent`.

## Provider selection — HONEST STATUS

**No real payment provider is integrated in this repository.**

- `BILLING_PROVIDER` selects the provider and defaults to `NONE`.
- `getProvider("NONE")` throws — no code silently pretends a gateway exists;
  billing without a provider uses out-of-band / manual recording.
- The only concrete implementation is `FakeBillingProvider` (`FAKE`): a
  DETERMINISTIC, offline, in-repo test double used by the verification gate. It
  makes no network call. It fails a payment when the idempotency key contains
  `FORCE_FAIL`, and signs webhooks with a fixed TEST secret so real
  signature-verification logic can be exercised. It is never production
  connectivity.

## Adding a real provider

Implement `BillingProvider` for the provider, map its kind in `getProvider`,
configure `BILLING_PROVIDER` and the provider's webhook signature secret via the
environment, and register its webhook endpoint. Do NOT fake production
connectivity or insert real credentials into the repo.
