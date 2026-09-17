# Reconciliation (Phase D3)

A lightweight boundary — NOT a finance analytics engine — whose job is "no
silent financial divergence between Aarogya and a provider".

`runReconciliation` (platform-only) scans and records
`BillingReconciliationException` rows for:

- **STATE_MISMATCH** — an Aarogya payment marked succeeded whose provider state
  disagrees.
- **MISSING_PROVIDER_PAYMENT** — a payment with a provider ref the provider does
  not recognise.
- **STUCK_PAYMENT** — a payment attempt left pending beyond a threshold.
- **REFUND_MISMATCH** — the (guarded) invariant `refundedMinor <= amountMinor`
  surfaced if it were ever violated.
- **UNKNOWN_REFERENCE** — raised by the webhook pipeline when a verified event
  references a payment Aarogya does not know (rather than fabricating state).

Exceptions de-duplicate per `(kind, providerRef)` and can be resolved
(`resolveException`). Every flag/resolve is audited.
