# D5 — verification matrix

| Capability | Status |
| --- | --- |
| Revenue operations (invoiced/collected/outstanding/overdue) | VERIFIED |
| Accounts receivable (per org) | VERIFIED |
| Aging (deterministic, by dueAt) | VERIFIED |
| Authoritative outstanding (single calculation) | VERIFIED |
| Collections state + activity | VERIFIED |
| Payment failure intelligence | VERIFIED |
| Revenue leakage detection + findings | VERIFIED |
| Leakage idempotency (concurrency-safe) | VERIFIED |
| Reconciliation intelligence + triage | VERIFIED |
| Reconciliation resolution never mutates money | VERIFIED |
| Provider health (honest NOT_CONFIGURED) | VERIFIED |
| Commercial dashboard (UI) | IMPLEMENTED |
| Organization commercial profile (UI) | IMPLEMENTED |
| Reports (revenue/ar_aging/payments/reconciliation) + CSV | VERIFIED |
| MRR / ARR (deterministic run-rate) | IMPLEMENTED |
| Tenant isolation | VERIFIED |
| Platform authorization | VERIFIED |
| PostgreSQL concurrency | VERIFIED (26/26 gate) |
| Migration replay / zero drift | VERIFIED |
| Razorpay sandbox connectivity | BLOCKED (no credentials) |
| Razorpay production connectivity | BLOCKED / NOT READY |
| Proration | DEFERRED |
| Metered billing | DEFERRED (no canonical usage ledger) |
| Invoice PDFs | DEFERRED |
| Automated scheduler | DEFERRED (no cron infra; explicit service boundaries exist) |
| Revenue recognition / accounting | NOT APPLICABLE (out of scope) |

Nothing is marked VERIFIED on the basis of a mock. Provider connectivity is
unchanged from D4: adapter verified offline, sandbox/production BLOCKED until
credentials are configured. D5 is NOT "production-ready for live payments".
