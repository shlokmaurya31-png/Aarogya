# Phase D3 — SaaS billing & payment infrastructure: readiness

D3 adds the AAROGYA COMMERCIAL billing layer: how the platform charges an
organization for its subscription, records the money, and keeps its commercial
state consistent. It is implemented, migrated on both engines, and verified on
real PostgreSQL 16. **No real payment provider is integrated** — see
[provider-boundary](provider-boundary.md).

## Scope

Implemented: SaaS billing accounts, plan pricing (effective-dated/versioned),
billing periods, invoices + invoice lines (server-computed amounts, immutable
after finalize, deterministic numbering), a tax calculation boundary, credits &
adjustments, payment attempts + payments (idempotent), refunds (bounded,
idempotent), a provider abstraction with a deterministic fake, webhook ingestion
(verified / idempotent / out-of-order safe), a reconciliation boundary,
subscription renewal integrating the D2 lifecycle, the failed-payment dunning
path, billing audit, and the enterprise billing workspace UI.

Deliberately NOT built: any real payment gateway, invoices/dunning beyond the
states above, a general ledger / double-entry accounting, GST filing, TDS,
payroll, metered billing. See the phase brief's scope limits.

## Domain separation

The SaaS billing domain (`Billing*` / `OrganizationBilling*` / `PlanPrice`
models under `src/lib/billing/`) is entirely separate from the hospital revenue
cycle (`BillingAccount` / `Invoice` / `Payment` / `Refund` / `Payer` / `Claim`,
which bill patients and insurers). No model, table, permission or service is
shared between the two.

## Verification

| Gate | Result |
| --- | --- |
| Prisma validate | clean |
| SQLite migration (applied) | clean, additive |
| PostgreSQL migration (replay from zero) | clean; **zero schema drift** |
| TypeScript / build | clean |
| Unit tests (`vitest run`) | 840/840 (incl. 8 new billing) |
| D3 billing gate — PostgreSQL 16 | **28/28** (security + semantics + 5 concurrency races) |
| D3 billing gate — SQLite | 23/23 (concurrency skipped by design) |
| Regression: D2 commercial (PG) | 26/0 |
| Regression: D1 tenancy (PG) | 41/0 |
| Regression: C4 trust-layer (PG, fresh seed) | 66/0 |
| Regression: C6 control plane (PG) | 140/0 |

Reproduce the PG gate with `docs/PHASE_B_FINAL_INTEGRITY_GATE.md §7`, then
`DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-saas-billing.ts`.

### Concurrency races proven (PostgreSQL)

Duplicate renewal → one invoice + one payment; duplicate payment (same key) →
one payment applied once; over-payment race (different keys, full amount each) →
exactly one applies, never over-paid; concurrent refund → exactly one full
refund, never over-refunded; duplicate webhook delivery → processed exactly once.

## Amount safety

Every amount is an integer minor unit (paise); never a Float. Totals are
computed server-side from the resolved `PlanPrice` and the invoice lines. The
client can request "renew" or "pay invoice X" but never sets a price, tax,
discount, total or refund amount. Over-payment and over-refund are prevented by
atomic guarded `UPDATE`s, and idempotency by unique keys + raw
`INSERT … ON CONFLICT DO NOTHING`.

## Provider verification status

- **DOMAIN VERIFIED** — yes (28/28 PG gate against the domain + a deterministic
  fake provider).
- **PROVIDER SANDBOX VERIFIED** — no (no sandbox credentials configured).
- **PRODUCTION READY** — no. No real gateway is integrated; production billing
  requires onboarding a provider, implementing its adapter behind the existing
  `BillingProvider` interface, and configuring `BILLING_PROVIDER` + its webhook
  signature secret.

## Remaining risks / notes

- No cron exists in this codebase; renewal and reconciliation are triggered
  explicitly (platform action / route), consistent with the rest of the system.
  A scheduler would call the same idempotent services.
- Failed-payment dunning advances D2 state (ACTIVE → PAST_DUE → GRACE) and never
  instantly cuts access; suspension remains a deliberate later transition.
- The tax module is a boundary only (one seeded rate, `GST_18`); it makes no
  compliance claim. See [invoicing](invoicing.md).

See [[aarogya-phase-d2-commercial]] for the layer D3 sits on.
