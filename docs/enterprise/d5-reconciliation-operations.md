# D5 — reconciliation operations

Operational intelligence over BillingReconciliationException (provider
RECONCILIATION exceptions from D4 + D5 LEAKAGE findings).

Dashboard (`getReconciliationDashboard`, platform): open count, critical count,
by type / provider / severity / age buckets, recently resolved.

Triage (platform, race-safe): assign; then a guarded status transition
OPEN → {ACKNOWLEDGED, RESOLVED, DISMISSED}, ACKNOWLEDGED → {RESOLVED, DISMISSED}.
RESOLVED/DISMISSED require a resolution note and set the fast `resolved` boolean +
resolver attribution. Concurrent transitions are guarded by an updateMany on the
current status, so exactly one wins (verified). A resolution records WHAT
happened; it NEVER silently alters canonical money.

## Severity rules (deterministic)
- CRITICAL: financial amount mismatch, over-refund risk, duplicate financial
  application, orphan payment on a VOID invoice.
- HIGH: stuck payment, missing provider payment, missing renewal invoice,
  unresolved provider/local state mismatch.
- MEDIUM: commercial-state lag, non-critical metadata mismatch.
