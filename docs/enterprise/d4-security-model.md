# D4 — security model

Reuses the existing authorization architecture (D1 tenant context, D2 commercial
permissions, C4 authorization, audit) — no second system.

- **No secrets stored.** Provider credentials live only in the environment; never
  in Prisma, never returned from a route, never sent to the browser. Provider
  references are opaque and safe. Audit never logs secrets.
- **Server-authoritative money.** Amount, currency, organization, invoice,
  subscription and status are derived server-side. Webhook amounts are only
  cross-checked against the server amount; a mismatch reconciles.
- **Tenant isolation.** Every billing object derives its organization from
  server-side context; cross-org access is 404-shaped; cross-org refund/credit is
  not expressible.
- **Platform-only mutation.** Renew, finalize/void, payment, refund (domain and
  provider), credit, dunning, provider customer sync, provider configuration and
  reconciliation require `commercial:platform:manage`. Ordinary staff and org
  admins cannot charge/refund/credit/void/change currency/change provider config.
- **Mass-assignment safe.** Routes accept only whitelisted fields via zod; ids,
  amounts, statuses, provider refs and actor are never client-set.
- **Webhook trust.** Signature-verified, idempotent, replay- and order-resistant.
- **Distributed-failure discipline.** Customer sync and provider refunds reconcile
  on ambiguous provider outcomes rather than pretending exactly-once.

Adversarial coverage: see scripts/verify-postgres-d4-billing.ts (spoofed
signature, out-of-order events, unknown/mismatched references, org-admin denied
dunning/sync/provider-refund) and the D3 gate (cross-tenant, over-pay/over-refund,
duplicate payment/refund/webhook).
