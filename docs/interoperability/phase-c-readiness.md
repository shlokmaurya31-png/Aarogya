# Phase C — India Interoperability Readiness

Final assessment across C1–C6. Written 2026-09-12.

**Verdict: PASS WITH EXTERNAL BLOCKER.**

The architecture is complete, verified and adversarially tested. Every remaining
gap is external material this repository cannot manufacture: onboarding,
credentials, certificates, and one specification that is not published.

Each capability is marked with exactly one of:
`IMPLEMENTED` · `TESTED` · `SANDBOX VERIFIED` · `PRODUCTION VERIFIED` ·
`EXTERNAL BLOCKER`. Where several apply, the strongest *earned* one is shown and
the rest are stated explicitly.

---

## 1. ABDM

| Capability | State | Note |
|---|---|---|
| Adapter boundary | IMPLEMENTED, TESTED | |
| Protocol contract (M3 v2.5) | IMPLEMENTED, TESTED | read from the published PDF, pinned, frozen by tests |
| Gateway discovery | SANDBOX VERIFIED | live HTTP 200 against `dev.abdm.gov.in` |
| JWKS retrieval | SANDBOX VERIFIED | live HTTP 200 |
| Session endpoint contract | SANDBOX VERIFIED | live HTTP 400 `ABDM-9999` — a domain rejection, which proves the contract |
| Authenticated session | EXTERNAL BLOCKER | no credentials exist |
| Consent request / notify | IMPLEMENTED, TESTED | not sandbox verified — needs credentials |
| Health-information request | IMPLEMENTED, TESTED | not sandbox verified — needs credentials |
| Health-information response (ECDH) | EXTERNAL BLOCKER | crypto parameters pinned; key agreement deliberately not implemented |
| ABHA creation (M1) | EXTERNAL BLOCKER | specification not obtained; no code written |
| HIP capability (M2) | EXTERNAL BLOCKER | specification not obtained; no code written |
| Production | EXTERNAL BLOCKER | never attempted; `productionVerifiedAt` is null |

Detail: [`abdm-production-readiness.md`](./abdm-production-readiness.md).

## 2. FHIR

| Capability | State | Note |
|---|---|---|
| R4 4.0.1 resource mapping | IMPLEMENTED, TESTED | Patient, Encounter, Condition, Observation, DocumentReference, Coverage, Claim, Organization |
| DocumentBundle composition (ABDM) | IMPLEMENTED, TESTED | Bundle type `document`, Composition first |
| ClaimBundle composition (NHCX) | IMPLEMENTED, TESTED | Bundle type `collection`, asserted at runtime |
| Structural validation | IMPLEMENTED, TESTED | required elements, cardinality, references |
| Import staging and conflict flagging | IMPLEMENTED, TESTED | never written directly to clinical tables |
| Reverse mapping | IMPLEMENTED, TESTED | staged into `ImportedResource` |
| Terminology mapping | IMPLEMENTED, TESTED | |
| **Profile validation against StructureDefinitions** | **EXTERNAL BLOCKER** | the official package has not been integrated. Validation is **structural only**. |
| Conformance | **NOT CLAIMED** | see §3 |

## 3. FHIR conformance — stated plainly

Aarogya composes **structurally valid FHIR R4**. It does **not** validate
against the ABDM StructureDefinition package, and therefore makes **no claim of
profile conformance**.

The distinction matters: a bundle can be structurally correct R4 and still fail
an ABDM profile. Until the official package is integrated and a validator runs
against it, profile validation is marked `BLOCKED_EXTERNAL` in the control plane
and no screen says "conformant".

To close it: obtain the NRCeS StructureDefinition package, integrate a validator,
and run it in CI. Nothing else about the FHIR layer needs to change.

## 4. NHCX

| Capability | State |
|---|---|
| Claim packaging, versioning, idempotency | IMPLEMENTED, TESTED |
| Consent enforcement (INSURANCE) | IMPLEMENTED, TESTED |
| Query / response workflow | IMPLEMENTED, TESTED |
| Settlement and reconciliation | IMPLEMENTED, TESTED |
| Callback ledger and replay guard | IMPLEMENTED, TESTED |
| FHIR ClaimBundle (`collection`) | IMPLEMENTED, TESTED |
| **Transport** | **EXTERNAL BLOCKER — NOT IMPLEMENTED** |
| Sandbox | EXTERNAL BLOCKER |
| Production | **NOT ENABLE-ABLE** — refused in code |

Detail: [`nhcx-production-readiness.md`](./nhcx-production-readiness.md).

## 5. Consent

| Capability | State |
|---|---|
| Purpose + explicit scopes + named recipient + period | IMPLEMENTED, TESTED |
| `ALL_CLINICAL` deliberately excludes `BILLING` | IMPLEMENTED, TESTED |
| Re-checked at authorization, not only at request | IMPLEMENTED, TESTED |
| Re-checked before the PROCESSING transition (C2 P2 fix) | IMPLEMENTED, TESTED |
| Revocation stops future disclosure, preserves past records | IMPLEMENTED, TESTED |
| ABDM purpose-code mapping, lossy mappings flagged | IMPLEMENTED, TESTED |

## 6. Authorization

| Capability | State |
|---|---|
| C4 ABAC engine: permission → facility → relationship → step-up → consent | IMPLEMENTED, TESTED |
| Step-up ordering before relationship/consent (no enumeration leak) | IMPLEMENTED, TESTED |
| Every denial audited through a single exit point | IMPLEMENTED, TESTED |
| Break-glass relaxes exactly one policy, never crosses a tenant | IMPLEMENTED, TESTED |
| Break-glass unlocks nothing in the control plane | IMPLEMENTED, TESTED |
| `AAROGYA_ADMIN` is not a clinical superuser | IMPLEMENTED, TESTED |
| Maker/checker for production enablement | IMPLEMENTED, TESTED |

## 7. External identity

| Capability | State |
|---|---|
| ABHA / HFR / HPR as mappings, never replacements for canonical ids | IMPLEMENTED, TESTED |
| Identifier-system ↔ entity-type rules enforced | IMPLEMENTED, TESTED |
| Facility-scoped, cross-facility mapping refused | IMPLEMENTED, TESTED |
| Deterministic resolution; no probabilistic matching | IMPLEMENTED, TESTED |
| Unresolvable inbound data quarantined, never guessed onto a patient | IMPLEMENTED, TESTED |

## 8. Exchange

| Capability | State |
|---|---|
| Unified operational view across ABDM and NHCX | IMPLEMENTED, TESTED |
| Protocol state preserved alongside the operational projection | IMPLEMENTED, TESTED |
| Correlation from UI action to final state | IMPLEMENTED, TESTED |
| Bounded, category-driven retry | IMPLEMENTED, TESTED |
| Consent/authorization failures never retryable | IMPLEMENTED, TESTED |
| Dead exchanges surface as `REQUIRES_REVIEW` with an alert | IMPLEMENTED, TESTED |
| Manual retry reuses original idempotency identity | IMPLEMENTED, TESTED |

## 9. Callbacks

| Capability | State |
|---|---|
| Shared-secret authentication, constant-time, fail-closed | IMPLEMENTED, TESTED |
| ±10 minute skew window | IMPLEMENTED, TESTED |
| Correlation to a server-generated id | IMPLEMENTED, TESTED |
| Replay guard as a database unique constraint | IMPLEMENTED, TESTED |
| Body stored as hash + size only | IMPLEMENTED, TESTED |
| Facility never read from the body | IMPLEMENTED, TESTED |
| Disabled integration refuses inbound too | IMPLEMENTED, TESTED |

## 10. Audit, provenance, privacy, security, configuration, observability

| Capability | State |
|---|---|
| `AuditEvent` (what Aarogya did) separate from `InteropProvenance` (origin of a representation) | IMPLEMENTED, TESTED |
| Server-derived actor and facility on every event | IMPLEMENTED, TESTED |
| No clinical payload in audit detail, logs or metrics | IMPLEMENTED, TESTED |
| Refused dispatches audited as first-class events | IMPLEMENTED, TESTED |
| Imported data never presented as locally authored | IMPLEMENTED, TESTED |
| Data minimisation and per-document authorization | IMPLEMENTED, TESTED |
| Secrets never in the database, API, UI or logs | IMPLEMENTED, TESTED |
| Configuration versioning and rollback | IMPLEMENTED, TESTED |
| Certificate lifecycle (metadata only) | IMPLEMENTED, TESTED |
| Certificate rotation | IMPLEMENTED, TESTED — **records** rotation, does not perform it |
| Deterministic alerts, de-duplicated by constraint | IMPLEMENTED, TESTED |
| Metrics grouped by integration and facility | IMPLEMENTED, TESTED |

## 11. Production

| Item | State |
|---|---|
| Environment isolation (LOCAL / SANDBOX / PRODUCTION) | IMPLEMENTED, TESTED |
| Production never inferred from URL or credentials | IMPLEMENTED, TESTED |
| Maker/checker approval required | IMPLEMENTED, TESTED |
| Reconfiguration clears approval and verification | IMPLEMENTED, TESTED |
| Test harness cannot become a production adapter | IMPLEMENTED, TESTED |
| **ABDM production** | **NOT ENABLED** — external blocker |
| **NHCX production** | **NOT ENABLE-ABLE** — contract unverified |

---

## 12. Verification totals

| Suite | Result |
|---|---|
| Vitest | 804 passed / 56 files, 0 failures |
| TypeScript | 0 errors |
| Production build | PASS |
| Lint | 3 errors, 23 warnings — identical to the pre-C6 baseline, all pre-existing |
| SQLite migrations | 34, replay from zero, **0 drift** |
| PostgreSQL migrations | 25, replay from zero, **0 drift** |
| Phase B final gate (PostgreSQL) | 74 passed, 0 failed |
| C1 interoperability (PostgreSQL) | 80 passed, 0 failed |
| C2 ABDM readiness (PostgreSQL) | 46 passed, 0 failed |
| C3 ABDM integration (PostgreSQL) | 26 passed, 0 failed |
| C4 trust layer (PostgreSQL) | 66 passed, 0 failed |
| C5 NHCX (PostgreSQL) | 111 passed, 0 failed |
| C6 control plane (PostgreSQL) | **140 passed, 0 failed** |
| Phase 5 billing (PostgreSQL) | 13 passed, 0 failed |

PostgreSQL 16.14 (Docker, `postgres:16-alpine`), fresh database and seed per
suite.

---

## 13. Compliance

Phase C implements **controls**: consent-gated disclosure, purpose limitation,
data minimisation, tenant isolation, immutable audit, provenance separation,
integrity hashing, environment isolation and maker/checker separation.

Implementing controls is not the same as being compliant. **No claim of DPDP
compliance, ABDM certification or NHCX certification is made or implied.** Those
are legal and organisational determinations requiring assessment of deployment,
operations, contracts and governance — none of which lives in this repository.
