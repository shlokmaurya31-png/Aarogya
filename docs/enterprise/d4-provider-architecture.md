# D4 — provider architecture

Aarogya owns all domain state; a provider only executes payment and maps back via
opaque references. Provider SDK objects never become persisted domain models.

## Configuration (`provider/config.ts`)
Server-only. Credentials come exclusively from the environment
(`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, optional
`RAZORPAY_BASE_URL`, `RAZORPAY_WEBHOOK_TOLERANCE_SECONDS`) and are never persisted
in Prisma, returned from a route, or sent to the browser. A missing/invalid
config throws a deterministic `ProviderConfigError` (503), never leaking values.
`isProviderConfigured(kind)` reports availability without throwing.

## Selection (`provider/index.ts`)
`BILLING_PROVIDER` selects NONE (default) / FAKE / RAZORPAY. `getProvider("NONE")`
throws (no silent gateway); `getProvider("RAZORPAY")` throws if unconfigured.
`hasRealProvider()` is true only when RAZORPAY is selected AND configured — always
false in this repo.

## Adapter (`provider/razorpay.ts`)
Implements the official Razorpay REST contract (Orders, Payments, Refunds,
Customers) over an injectable `HttpTransport` (so logic is testable offline).
Razorpay's flow is asynchronous: `createPayment` creates an ORDER (the request
reference) and returns status `pending`; the actual payment is confirmed by a
`payment.captured` webhook. Provider statuses are normalized to Aarogya's
(captured→succeeded, failed→failed, created/authorized→pending). Amounts are
paise, matching Aarogya's minor units. STATUS: ADAPTER VERIFIED; live calls
EXTERNALLY BLOCKED (no credentials).
