# D4 — dunning

`processBillingDunning()` is an explicit, idempotent, bounded, tenant-safe service
boundary — NOT a scheduler and not embedded in a request hot path. This codebase
has no cron, so automated scheduling is NOT claimed; a future job runner, an
admin, or a test calls this same function.

It advances a subscription at most ONE stage per run (modelling a daily job):
ACTIVE →(an invoice is past its due date and unpaid)→ PAST_DUE →(still unpaid)→
GRACE (a 7-day window set by D2) →(grace elapsed)→ SUSPENDED. It never suspends on
the first failure. Payment FAILURE is separated from commercial SUSPENSION.

All transitions go through the D2 lifecycle service (audited, allow-listed).
Suspension changes commercial entitlements per D2 only; it NEVER revokes
safety-critical clinical access, which remains governed by C4. VERIFIED by the
gate (ACTIVE→PAST_DUE→GRACE→SUSPENDED, one step per run).

DEFERRED: automated scheduling (no cron infrastructure exists in-repo).
