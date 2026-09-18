# D5 — commercial intelligence (overview)

D5 is an operational/read intelligence layer over the canonical D2/D3/D4 billing
domain. It adds NO second source of financial truth: every figure is derived,
server-side, from persisted invoices/payments/refunds/credits/subscriptions/
reconciliation/webhook records. It is NOT accounting, NOT an ERP, NOT statutory
reporting, NOT GST filing.

Sections: revenue operations, accounts receivable, aging, collections, payment
failure intelligence, revenue leakage detection, reconciliation intelligence,
provider health, dashboards, reports/CSV. Mutations (collection notes, exception
triage, leakage findings) are authorized and audited; canonical money is never
altered by D5.

Feature classification:
- Revenue ops / AR / aging / outstanding — VERIFIED
- Collections state + activity — VERIFIED
- Payment failure intelligence — VERIFIED
- Leakage detection + findings — VERIFIED
- Reconciliation intelligence + triage — VERIFIED
- Provider health — VERIFIED (honest NOT_CONFIGURED)
- MRR/ARR — IMPLEMENTED (deterministic run-rate; documented)
- Reports + CSV export — VERIFIED
- Razorpay sandbox/production — BLOCKED (no credentials, unchanged from D4)
- Proration / metered billing / invoice PDFs / scheduler — DEFERRED

Canonical source map: see d5-revenue-operations.md.
