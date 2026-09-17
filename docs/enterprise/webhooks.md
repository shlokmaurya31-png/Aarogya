# Webhooks (Phase D3)

Pipeline: **verify signature → normalize → idempotency → canonical event →
domain transition**. Never webhook → blind database update.

- **Authenticity**: `provider.verifyWebhook` checks the signature over the exact
  raw body. An unverified event is recorded as `REJECTED` and never applied.
  A rejected event is keyed by a payload hash, NEVER the claimed event id — so an
  attacker cannot pre-register (and thereby suppress) a real event by sending a
  same-id event with a bad signature.
- **Idempotency**: unique `(providerKind, externalEventId)`. Processing is a
  guarded `RECEIVED/VERIFIED → PROCESSED` claim wrapped around the domain effect
  in one transaction, so the same event delivered N times (or concurrently) is
  processed at most once (proven: 8 concurrent identical deliveries → one).
- **Ordering is not trusted**: an event referencing an unknown payment raises a
  reconciliation exception instead of fabricating state; known payments already
  carry their state from the synchronous flow, so the webhook is a confirmation.
- Only a payload HASH is stored — never the raw sensitive body or any secret.

Endpoint: `POST /api/hospital/enterprise/commercial/billing/webhooks/[provider]`,
signature in `x-aarogya-signature`. Unauthenticated at the session layer by
design (authenticity is the signature); 400 on bad signature, 200 otherwise.
