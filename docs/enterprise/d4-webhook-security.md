# D4 — webhook security

Pipeline: raw request → signature verification → normalization → idempotency →
trusted claim → domain effect → reconciliation if required. Never
webhook → blind update; never trusted before verification.

- **Signature**: verified over the exact raw body. Razorpay = HMAC-SHA256 hex with
  the webhook secret, constant-time compared. An unverified event is REJECTED and
  stored under `rejected:<payloadHash>`, NEVER its claimed id — so a spoofed
  same-id event cannot suppress a real one. VERIFIED (unit + gate).
- **Idempotency**: unique `(providerKind, externalEventId)` + a guarded
  RECEIVED/VERIFIED → PROCESSED claim around the effect in one transaction. The
  same event delivered N times (or concurrently) applies once. Razorpay's stable
  id is the `X-Razorpay-Event-Id` header, threaded as an event-id hint. VERIFIED.
- **Ordering not trusted**: the payment state machine guards every transition; a
  stale/duplicate event that would move state backwards is ignored; a genuine
  divergence (unknown order, amount mismatch) becomes a reconciliation exception.
  VERIFIED.
- **Async capture**: a verified `payment.captured` for a known order records the
  canonical payment, advances renewal, and cures dunning. Unknown → reconcile.
- **Storage**: only a payload HASH + normalized fields (verifiedAt, normalizedType,
  providerResourceRef, lastError*) are stored — never the raw body or any secret.

Endpoint: `POST /commercial/billing/webhooks/[provider]`, signature in
`x-aarogya-signature` (FAKE) or `x-razorpay-signature` (Razorpay), event id in
`x-razorpay-event-id`. Unauthenticated at the session layer by design.
