# D3 security model

## Principles

- **Server-authoritative money.** The client may request "renew" or "pay invoice
  X"; the server determines the plan version, price, tax, total and refund
  amount. Price/tax/discount/total/refund are never accepted from the client.
- **Tenant isolation.** Every billing object is scoped to a server-resolved
  organization (D1 `tenantContext`); `organizationId` is never trusted from the
  client. Cross-org reads are 404-shaped; cross-org refunds/credits are not
  expressible.
- **Platform-only financial mutation.** Renew, finalize/void invoice, record
  payment, refund, issue/apply credit, provider mapping, webhook processing and
  reconciliation require `commercial:platform:manage`. No self-charge,
  self-credit, self-refund or self-void. Reads use `commercial:read`; benign
  billing-contact edits use organization admin.
- **Immutability.** A finalized invoice's number, amounts and lines are frozen;
  corrections are credits / void+replacement.
- **Idempotency & no over-apply.** Unique keys + raw `INSERT … ON CONFLICT DO
  NOTHING` for exactly-once creation; atomic guarded `UPDATE`s prevent
  over-payment and over-refund even under concurrency.
- **Webhook trust.** Signature-verified, idempotent, replay- and order-resistant;
  a bad signature is rejected and never keyed by its claimed event id.
- **No secrets.** No card data, provider secrets, webhook secrets or tokens are
  stored in the database or in audit metadata; only opaque references and hashes.

## Adversarial coverage (PostgreSQL gate)

Cross-org billing read; org-admin self-renew / self-credit / self-payment;
client amount/currency manipulation (server recomputes); invoice mutation after
finalize; refund exceeding balance; cross-org credit application; over-payment
and over-refund races; duplicate payment / refund / webhook; webhook signature
bypass and replay; failed-payment dunning without instant cut. All enforced —
see `scripts/verify-postgres-saas-billing.ts` (28/28) and
[d3-readiness](d3-readiness.md).

## Audit

Every billing mutation is recorded in the `commercial.billing.*` audit
namespace, org-scoped, transaction-atomic where it matters — never carrying
card data, provider/webhook secrets or tokens.
