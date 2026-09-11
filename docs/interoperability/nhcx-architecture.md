# NHCX / Health Claims Exchange — Architecture

Phase C5. Builds a claims-exchange boundary on top of the Phase 5 billing domain
and the C1–C4 interoperability and trust layers. It adds no second source of
financial truth and no second patient, encounter, provider or claim model.

---

## 1. What this phase is, and is not

**It is** the complete provider-side claims lifecycle as domain logic: package
composition from canonical records, versioned immutable submissions, a verified
FHIR representation, idempotent dispatch, an inbound callback ledger, the payer
query workflow, settlement recording and reconciliation, all under C4
authorization, consent and audit.

**It is not** a live NHCX integration. The transport contract could not be
verified against a primary source — see
[`nhcx-contract-matrix.md`](./nhcx-contract-matrix.md) — so no endpoint, header,
envelope, error code or crypto parameter has been guessed. The adapter refuses
every operation and advertises zero capabilities. See §7.

---

## 2. Layering

```
┌───────────────────────────────────────────────────────────────────┐
│ UI        /hospital-os/claims/exchange (workspace, 8 tabs)        │
│           /hospital-os/claims          (Phase 5 worklist, intact) │
├───────────────────────────────────────────────────────────────────┤
│ API       /api/hospital/claims/nhcx            build/dispatch/... │
│           /api/hospital/claims/nhcx/callback   inbound (no session)│
│           /api/hospital/claims/nhcx/queries                       │
│           /api/hospital/claims/nhcx/reconciliation                │
├───────────────────────────────────────────────────────────────────┤
│ Domain    claimPackage  submission  callbacks  queries            │
│           reconciliation  stateMachines  errors  fhirMapper       │
├───────────────────────────────────────────────────────────────────┤
│ Boundary  adapter (UnverifiedNhcxAdapter)  config  contract       │
├───────────────────────────────────────────────────────────────────┤
│ Trust     C4 authorize engine · consent · audit · break-glass     │
├───────────────────────────────────────────────────────────────────┤
│ Canonical Claim · Invoice · InvoiceLine · Payment · PatientCoverage│
│           Patient · Encounter · ClinicalDocument · Payer          │
└───────────────────────────────────────────────────────────────────┘
```

Every arrow points downward. Nothing in the domain layer writes a clinical fact,
and nothing in the boundary layer reads one directly.

---

## 3. What was extended rather than duplicated

| Concern | Reused |
|---|---|
| Claim identity, totals, lifecycle | canonical `Claim` + `ClaimStatus` (Phase 5) |
| Claim line amounts | `InvoiceLine.netAmountMinor` via `ClaimLine` |
| Coverage, payer, plan | `PatientCoverage`, `Payer`, `PayerPlan` |
| Pre-authorization | `PreAuthorization` (Phase 5) |
| Documents | `ClinicalDocument` + its version counter |
| Payer participant code | `ExternalIdentifier` with `entityType: "PAYER"` |
| Authorization, consent, audit | C4 engine, `InteropConsent`, `AuditEvent` |
| FHIR resource mapping | C1 mappers (`mapPatientToFhir`, `mapDocumentToFhir`, …) |

`Claim.invoiceId` is `@unique`, so there is exactly one claim per invoice and
resubmission **cannot** be modelled as a second `Claim` row. That constraint is
why `ClaimSubmission` exists as a separate versioned record.

New tables (all additive):

- `ClaimSubmission` — one immutable submission attempt, `@@unique([claimId, version])`
- `ClaimSubmissionDocument` — exactly which document *version* was included
- `NhcxExchange` — one protocol attempt; `idempotencyKey` and `correlationId` unique
- `NhcxCallbackEvent` — inbound ledger; `@@unique([facilityId, messageType, externalEventId])`
- `ClaimQuery` — payer question and provider response
- `ClaimSettlement` — external settlement notification; `@@unique([facilityId, externalSettlementRef])`
- `ReconciliationException` — a detected discrepancy, never an automatic correction

---

## 4. Canonical state vs protocol state

Three machines, deliberately separate (full detail in
[`nhcx-state-machines.md`](./nhcx-state-machines.md)):

1. `Claim.status` — canonical billing truth, Phase 5, **unchanged**
2. `ClaimSubmission.status` — one attempt
3. `NhcxExchange.protocolState` — what the network said

Collapsing them would make *"we never sent it"* indistinguishable from *"they
rejected it"*. `canonicalStatusForSubmission()` maps between them and returns
`null` most of the time — a protocol event that says nothing about billing state
changes nothing. When it does speak, the move still goes through the existing
Phase 5 `isClaimTransitionAllowed()`; an illegal canonical transition is
declined, not forced.

---

## 5. Trust boundary

Nothing the client or the network sends is trusted:

| Input | Where it actually comes from |
|---|---|
| facility | the session, via `buildAuthorizationActor` |
| patient, encounter, coverage, payer | the canonical `Claim` → `Invoice` chain |
| claim total | recomputed from `InvoiceLine` rows every time |
| correlation id | server-generated UUID (`randomUUID`) |
| idempotency key | SHA-256 of `facility|claim|version|packageHash` |
| adjudication outcome | only from an authenticated, correlated callback |
| approved amount | integer-only; floats and strings are refused, never coerced |

`claim.submit` and `claim.dispatch` both require **consent** (purpose
`INSURANCE`) and **step-up** authentication, and both set
`breakGlassAllowed: false`. An emergency justifies reading a chart; it does not
justify disclosing it to an insurer.

Documents are minimised to `CLAIM_RELEVANT_DOCUMENT_TYPES` and then authorized
**individually** through the C4 engine. Every exclusion is reported in
`excludedDocuments` — nothing is dropped silently.

---

## 6. Idempotency and replay

Both guarantees are **database constraints**, not application checks, because
both failure modes occur concurrently in practice:

- outbound: `NhcxExchange.idempotencyKey @unique`. Eight concurrent dispatches
  of one submission produce one exchange and at most one adapter call; the
  losers catch `P2002` and return the winner's exchange with `deduplicated: true`.
- inbound: `@@unique([facilityId, messageType, externalEventId])`. Eight
  concurrent deliveries of one event produce one ledger row and one `ACCEPTED`;
  the rest report `DUPLICATE` and change nothing.

A retry reuses the **same** idempotency key, so retrying can never create a
second logical external submission. Non-retryable categories — notably
`DUPLICATE` — refuse to retry at all.

---

## 7. The adapter boundary

`UnverifiedNhcxAdapter` is the only adapter `getNhcxAdapter()` returns. It:

- reports `transportContractVerified: false`
- advertises `operations: []`
- returns `NOT_CONFIGURED` or `NOT_IMPLEMENTED` from every call, never `OK`

`NhcxContractHarness` is a deterministic **test** double. It is named
`NHCX_TEST_HARNESS`, its references are prefixed `HARNESS-`, its capabilities
carry the blocker *"This is a deterministic test harness, NOT an NHCX
connection"*, and no environment flag can put it on a production path.

When the specification and onboarding exist, the work is to fill in the adapter
method bodies. Nothing above the boundary should need to change.

---

## 8. Verification

- `src/lib/hospital/nhcx/nhcx.test.ts` — 81 unit tests
- `scripts/verify-postgres-nhcx.ts` — 111 adversarial assertions across 14
  sections against real PostgreSQL, including five genuine concurrency races

Defects this phase found and fixed are listed in
[`nhcx-readiness.md`](./nhcx-readiness.md).
