# D4 — reconciliation

Expanded from D3. Every exception carries: organization, kind, severity
(LOW/MEDIUM/HIGH/CRITICAL), entityType/entityId, providerRef/localRef,
description, detectedAt (createdAt), status (resolved), resolver
(resolvedByUserId) and resolvedAt.

Detected conditions:
- STATE_MISMATCH — local vs provider payment state disagree; or a webhook amount
  mismatch; or an illegal attempt transition from a stale event.
- MISSING_PROVIDER_PAYMENT — a payment ref the provider does not recognise.
- STUCK_PAYMENT — an attempt left pending beyond a threshold.
- REFUND_MISMATCH — the guarded refund invariant, or an ambiguous/failed provider
  refund, or a provider-success-but-local-failure during a provider refund.
- UNKNOWN_REFERENCE — a verified webhook (or a customer-sync partial failure)
  referencing an order/customer Aarogya cannot resolve.

`runReconciliation` (platform-only) scans payments and stuck attempts; the webhook
and customer-sync/refund paths flag on the spot. Exceptions de-duplicate per
(kind, providerRef) and are resolvable. No silent financial divergence. VERIFIED.
