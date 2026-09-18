# D5 — revenue leakage detection

`runLeakageDetection` (platform) is a DETERMINISTIC detector that records
FINDINGS (BillingReconciliationException, source="LEAKAGE") and NEVER mutates
financial data. Signals implemented:

- ORPHAN_PAYMENT (CRITICAL) — a payment applied to a VOID invoice.
- STATE_MISMATCH (CRITICAL) — invoice amountPaid exceeds total (invariant breach).
- COMMERCIAL_STATE_MISMATCH (MEDIUM) — an ACTIVE subscription with an overdue
  unpaid invoice (dunning has not advanced it).
- MISSING_INVOICE (HIGH) — a billable subscription past its period end with no
  renewal invoice for the new period (missed billing).

Findings are idempotent and RACE-SAFE: a unique `findingKey`
(`LEAKAGE:kind:entityId`) is set while a finding is OPEN, so concurrent detection
runs create at most one open finding per condition (insert-or-skip on the unique
constraint). Resolving a finding clears the key, so a persisting condition can be
re-detected later. Findings are triaged/resolved through the reconciliation
operations flow; no automatic destructive correction ever happens.
