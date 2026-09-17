# Payments (Phase D3)

A payment **attempt** (`BillingPaymentAttempt`, which may fail) is distinct from
a recorded **payment** (`BillingPayment`, money that succeeded). Only a succeeded
attempt yields a payment.

- **Idempotent**: both are keyed on a caller-supplied `idempotencyKey` via raw
  `INSERT … ON CONFLICT DO NOTHING`. N identical concurrent requests create
  exactly one row and apply money exactly once (proven: 8 concurrent identical
  payments → one payment).
- **No over-payment**: the invoice `amountPaidMinor` is a guarded running total,
  incremented by an atomic conditional `UPDATE` (`amountPaidMinor + amt <=
  totalMinor`). Concurrent full payments with different keys → exactly one
  applies (proven), the rest are refused.
- The UI never mutates payment state; only the services do. All amounts are
  server-validated against the invoice balance.
- `recordManualPayment` records a payment received out-of-band (no live gateway),
  wrapping attempt + payment in one Serializable transaction.

Failed payments advance the D2 dunning lifecycle — see
[refunds](refunds.md) is separate; dunning is in
[d3-readiness](d3-readiness.md) and `renewal.ts`.
