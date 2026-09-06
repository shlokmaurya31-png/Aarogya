# Phase 5 — Scope Calibration and Honest Deferrals

Phase 5 is a large build. This document separates what's fully built from
what's deliberately foundation-only, so a future phase doesn't assume
something is further along than it is.

## Fully built

Charge/Tariff/Invoice/Payment/Refund/Adjustment/Claim lifecycles end to
end, all 6 required concurrency mechanisms (verified against real
Postgres with genuine parallel requests), 18 new RBAC permissions with a
maker/checker split, ~27 new audit event types wired through every
mutation route, facility isolation, amount-tampering closed on every
automatic charge trigger plus the manual route, pharmacy/lab/imaging/
admission-discharge clinical integrations, a 5-screen billing UI, and a
full SQLite + Postgres migration/validation cycle.

## Foundation only (deliberately, not half-built and hidden)

| Area | What exists | What's deferred |
|---|---|---|
| Packages | CRUD + one manual "apply as a single lump charge" action | Auto-suggestion, exploding into component charges, usage-vs-package reconciliation |
| Pre-authorization | Manual status entry (staff reads the payer's decision off-system and types it in) | Live payer API integration, automatic expiry (staleness is a live-computed warning instead — this codebase has no cron/background job anywhere) |
| Claims | Full internal lifecycle, one claim per invoice, manual payer-decision entry | External payer/EDI integration (no X12, no payer portal API), split-claim-across-multiple-payers |
| Refunds | Refund of a payment's **unallocated** balance, full maker-checker lifecycle | Refunding money already applied to a paid invoice — requires first freeing the allocation via a `FinancialAdjustment`; a dedicated "deallocate" operation isn't built |
| Reconciliation | 4 on-demand aggregate queries, computed live | Scheduled/emailed reports, persisted snapshots, GL export, a BI warehouse |
| UI | 5 real screens (billing detail w/ tabs, coverage/preauth panel in patient chart, claims worklist, tariffs/packages/payers settings, reconciliation dashboard) | A patient-facing billing portal, PDF invoice rendering, standalone top-level screens for refunds/deposits/adjustments (these are row-actions inside existing screens instead) |
| Bed/accommodation billing | One bounded daily-rate policy (any partial day = full day, priced by the bed's *current* ward type at discharge time) | Mid-stay ward-transfer proration, interim/nightly charging before discharge on long admissions, a general rating-policy engine |
| Tax | `taxMinor` field on Invoice, computed via a flat rate parameter at issue time | No claim of GST/tax-authority compliance — fields exist, the system is not a tax authority |
| Scheduling parallel gap | N/A (out of scope) | `Appointment`'s scheduling conflict check has the same exact-timestamp-equality bug `ImagingStudy` had before its own Phase 4.5 fix — not touched this phase, still SQLite-only-safe (see `src/lib/hospital/appointment.ts`'s own docstring and `docs/PATIENT_FLOW.md`) |

## Explicitly not built (per the original brief)

External insurer API integrations, payment gateway integrations, UPI
gateway integrations, accounting ERP integration, GST filing integration,
HL7 financial messaging, FHIR financial resources, procurement, inventory
accounting, payroll, ICU/OT/blood-bank billing, an actuarial engine,
ML revenue prediction.

## A note on the concurrency-bug finding

Writing genuine concurrency tests for this phase (not sequential requests
labeled as concurrency tests) surfaced a real, previously-latent bug in
the idempotent-insert pattern inherited from Phase 4 — see
`docs/PHASE_5_FINANCIAL_INVARIANTS.md` for the full writeup. It's fixed
here, but it's worth noting explicitly: **this class of bug (a pattern
that looks correct and passes every sequential test, but breaks under
genuine Postgres concurrency) can exist anywhere else in the codebase
that hasn't been stress-tested with real parallel requests.** No claim is
made here that every prior phase's "Postgres-safe" assertions have been
re-verified with this specific failure mode in mind.
