# D4 — billing productionization (overview)

D4 moves Aarogya's commercial billing from DOMAIN-VERIFIED toward PROVIDER-READY,
without fabricating any external connectivity. It keeps the D3 architecture and
adds: a server-only provider configuration layer, a real Razorpay adapter behind
the existing `BillingProvider` boundary, an explicit payment state machine,
productionized webhooks (async capture), a dunning service boundary, customer
synchronization and provider-backed refunds with distributed-failure discipline,
and an expanded reconciliation model.

Honest status: **no Razorpay credentials exist in this repository.** The adapter
is real, contract-accurate code, unit-verified with an injected HTTP transport
and a known secret (ADAPTER VERIFIED). It has never made a live call, so it is NOT
sandbox- or production-verified. See d4-verification-matrix.md.

Levels used throughout these docs:
- IMPLEMENTED — code exists and is wired.
- VERIFIED — exercised by tests (unit and/or the PostgreSQL gate).
- EXTERNALLY BLOCKED — cannot be verified without external credentials/onboarding.
- DEFERRED — intentionally not built in D4.

Deferred in D4 (documented, not built): proration (the D2 model lacks a
mid-period price-delta source), metered billing (no canonical usage ledger),
invoice PDFs, a real scheduler (no cron in-repo). See d4-dunning.md / this file.
