# Phase C1 — India Digital Health Interoperability Foundation

Opens Phase C. This phase builds the **interoperability boundary** that lets
Aarogya speak ABDM/FHIR without letting any external system become a dependency
of the hospital.

## 1. The governing principle

```
LOCAL RECORD → CANONICAL AAROGYA RECORD → INTEROPERABILITY REPRESENTATION → EXTERNAL EXCHANGE
```

The canonical Phase B clinical domain remains the single source of truth.
Concretely, and enforced in code:

- **ABHA does not replace `Patient.id`.** It is a row in `ExternalIdentifier`
  pointing at a patient. A patient with no ABHA is in no way second-class, and
  the exported FHIR `Patient.id` is always the Aarogya id.
- **HFR does not replace `Facility.id`; HPR does not replace
  `HospitalStaffProfile.id`.** Same mechanism.
- **FHIR is a representation, not a database.** There is no FHIR table, no FHIR
  server, no REST capability statement. Bundles are composed on demand from
  canonical records and are not persisted.
- **External payloads never touch a clinical table.** Import stages into
  `ImportedResource`; promoting staged data into the record is a deliberate
  clinical act reserved for a later phase.

## 2. FHIR version decision

**FHIR R4, specifically 4.0.1.**

This is not a preference. The ABDM FHIR Implementation Guide published by NRCeS
(<https://nrces.in/ndhm/fhir/r4/>, IG v6.5.0) is built on R4 and defines the
India-specific profiles and the `DocumentBundle` used to exchange health-record
artefacts. Targeting anything else would not be ABDM-compatible.

From that IG, C1 implements the **DocumentBundle shape**: a Bundle of type
`document` whose first entry is a `Composition` indexing the rest, with artefact
types (`OPConsultRecord`, `DischargeSummaryRecord`, `DiagnosticReportRecord`,
`PrescriptionRecord`, `HealthDocumentRecord`) modelled in
`fhir/bundle.ts::DOCUMENT_BUNDLE_TYPES`.

Mappers live under `src/lib/hospital/interoperability/fhir/`, which is
**version-isolated** so an R5 or updated-IG mapping can be added alongside
rather than replacing it.

> **Conformance honesty:** C1 produces *structurally valid R4 resources*. They
> are **not** validated against the ABDM `StructureDefinition` profiles, so
> nothing in this codebase claims ABDM profile conformance. That validation
> requires the published profile package and is future work.

## 3. What was built

| Area | Module | Notes |
| --- | --- | --- |
| Vocabulary, state machines, facility guards | `interoperability/shared.ts` | Single chokepoint `assertEntityInFacility` |
| Configuration contract | `interoperability/config.ts` | Fails closed; names env vars, holds no secret |
| External identity (ABHA/HFR/HPR) | `interoperability/externalIdentity.ts` | Link / unlink / verify, conflict detection |
| Consent | `interoperability/consent.ts` | Purpose + scope + recipient + period + revocation |
| Exchange | `interoperability/exchange.ts` | Lifecycle, idempotency, bounded retry |
| Provenance | `interoperability/provenance.ts` | Distinct from AuditEvent; hash not payload |
| Terminology | `interoperability/terminology.ts` | The layer, not the data |
| FHIR types / mappers / bundle | `fhir/{types,mappers,bundle}.ts` | Deterministic, omit-never-invent |
| FHIR validation | `fhir/validate.ts` | Untrusted-input hardening |
| Export / import | `fhir/{export,import}.ts` | Consent-gated export; staging-only import |
| Adapters | `adapters/{types,abdm}.ts` | Replaceable boundary; never fakes connectivity |

Eight new Prisma models, all additive: `ExternalIdentifier`, `InteropConsent`,
`InteropConsentScope`, `HealthInformationExchange`, `InteropProvenance`,
`ImportedResource`, `TerminologyMapping`, `InteropConnection`.

## 4. The authorization equation

Consent is **one input, not the whole decision**. An export passes, in order:

1. authenticated session (RBAC permission at the route)
2. facility isolation — patient must belong to the caller facility
3. purpose match, recipient match, scope coverage, consent validity
4. scope filtering — only consented data classes are composed
5. provenance + audit

Deliberate design choices worth knowing:

- **`ALL_CLINICAL` does not imply `BILLING`.** Financial disclosure is a separate
  decision from clinical disclosure.
- **`PATIENT_ACCESS` needs no third-party consent artefact** — a patient
  receiving their own record is not a disclosure to someone else — but still
  requires facility scoping and valid scopes.
- **Consent is re-checked at authorization, not only at request.** A consent
  revoked between the two blocks the transfer.
- **Revocation blocks future exchange only.** Aarogya does not claim to delete
  records already delivered to a recipient it does not control; pretending
  otherwise would be a false assurance to the patient.

## 5. Failure isolation (§60)

The external call happens **outside** every clinical transaction:

```
local transaction → create/authorize exchange intent → COMMIT
(no transaction)  → adapter call → record outcome
```

An unreachable ABDM cannot roll back, block or corrupt care that already
happened. Admission, medication administration, documentation, emergency care
and discharge have **no** dependency on any module in this phase. With
everything switched off (the default), the only thing that does not work is
exchange.

## 6. Security findings from this phase

| Sev | Finding | Root cause | Fix |
| --- | --- | --- | --- |
| **P1** | A cross-facility `patientId` asserted on import returned **HTTP 200** with a per-resource "rejected" instead of refusing the request, so another facility patient id could be probed without the request failing. | The asserted patient was validated inside the per-resource loop, whose `catch` degraded the authorization failure into a data-quality outcome. | Hoisted the check to the top of `importFhirPayload`, so a cross-facility assertion fails the whole request. Regression-tested in `scripts/verify-postgres-interoperability.ts`. |

No resource was ever attached to the foreign patient, so this was an
authorization-reporting failure rather than a data leak — but a probe that
returns 200 is exactly how an attacker maps another tenant, and an operator
reading a dashboard would have seen "1 rejected resource" rather than "someone
attempted a cross-facility import".

## 7. Integration status — read this before claiming anything

These categories are deliberately kept apart.

**IMPLEMENTED LOCALLY** (works now, no external dependency)
- ABHA / HFR / HPR identifier mapping, with facility isolation and uniqueness
- Consent lifecycle, scope, purpose, recipient, expiry, revocation
- Exchange lifecycle, idempotency, bounded retry, failure recording
- FHIR R4 mapping, DocumentBundle composition, deterministic hashing
- FHIR payload validation and staged import with conflict detection
- Interoperability provenance and audit
- Terminology mapping layer

**SANDBOX-READY** (boundary exists, needs credentials to exercise)
- `AbdmAdapter` / `AbdmRegistryAdapter` behind `HealthInteroperabilityAdapter`
  and `RegistryAdapter`, driven by `ABDM_ENVIRONMENT`, `ABDM_BASE_URL`,
  `ABDM_CLIENT_ID`, `ABDM_CLIENT_SECRET`

**PRODUCTION-READY**
- *Nothing.* No ABDM operation has been executed against any ABDM environment.

**EXTERNALLY BLOCKED**
- ABDM sandbox onboarding, client credentials, registered callback URLs and (for
  several flows) an X.509 certificate. Without these the transport contracts
  cannot be implemented against a verified specification, so every adapter
  operation returns `NOT_CONFIGURED` or `NOT_IMPLEMENTED` rather than a
  fabricated success.

> **What is NOT true:** ABDM is not integrated. No ABHA has been verified. No HFR
> or HPR record has been synchronised. Nothing is FHIR-profile-conformant.
> `config.test.ts` exists specifically to keep these claims honest — it asserts
> that an unconfigured adapter can never return `OK` or a verified result.

## 8. Deployment prerequisites

```bash
ABDM_ENVIRONMENT=DISABLED    # DISABLED | SANDBOX | PRODUCTION  (default DISABLED)
ABDM_BASE_URL=               # required when not DISABLED
ABDM_CLIENT_ID=              # required when not DISABLED
ABDM_CLIENT_SECRET=          # required when not DISABLED — never committed
```

`checkEnvironmentSafety()` refuses the two dangerous mismatches: a production
build pointed at SANDBOX, and a non-production build pointed at PRODUCTION. The
connections endpoint surfaces the warning instead of throwing, so a
misconfiguration is visible without taking the hospital down.

No credential is ever persisted. `InteropConnection.clientIdEnvVar` stores the
*name* of an environment variable, and the connections route rejects any body
containing a secret-shaped field.

## 9. Deliberately out of scope for C1

Complete ABDM production onboarding, Aadhaar authentication, OTP infrastructure,
a PHR application, HFR/HPR registration, UHI, NHCX claims, PM-JAY, a full FHIR
server, SMART on FHIR, AI, national terminology datasets, nationwide patient
matching. These are later C phases.

## 10. Verification

- **504 Vitest tests / 50 files** (was 395 / 46 at Phase B close) — +109
- **319 PostgreSQL assertions / 0 failures** on a freshly seeded PostgreSQL 16
  (239 Phase B regression + 80 new C1)
- Full PostgreSQL migration history replays from zero with **zero drift**;
  SQLite tree likewise
- Migration is **fully additive**: 8 `CREATE TABLE` + indexes, no rebuild, no
  drop, no retype

```bash
# Fresh PostgreSQL 16 + full replay + seed + gate
docker run -d --name aarogya-c1-pg -e POSTGRES_PASSWORD=c1 -e POSTGRES_USER=c1 \
  -e POSTGRES_DB=aarogya_c1 -p 55434:5432 postgres:16

mkdir -p .pgreplay
sed 's/provider = "sqlite"/provider = "postgresql"/' prisma/schema.prisma > .pgreplay/schema.prisma
cp -r prisma/migrations-postgres-baseline .pgreplay/migrations
export DATABASE_URL="postgresql://c1:c1@localhost:55434/aarogya_c1"

npx prisma migrate deploy --schema .pgreplay/schema.prisma
npx prisma migrate diff --from-url "$DATABASE_URL" \
  --to-schema-datamodel .pgreplay/schema.prisma --exit-code --script   # must be empty
npx prisma generate --schema .pgreplay/schema.prisma
npx tsx prisma/seed.ts

npx tsx scripts/verify-postgres-interoperability.ts
for s in scripts/verify-postgres-*.ts; do npx tsx "$s"; done   # Phase B regression

npx prisma generate   # restore the SQLite client for local dev
```

The verification scripts are **not idempotent** — they consume identifiers,
consents and roster windows. Always drop, re-migrate and re-seed between runs;
see `docs/PHASE_B_FINAL_INTEGRITY_GATE.md` §7.

## 11. Known overlap to resolve in a later phase

`PatientIdentifier` (pre-existing, patient-scoped, already carries an `"ABHA"`
type) now sits alongside `ExternalIdentifier`. They were **not** merged in C1:
`PatientIdentifier` has no facility column, no verification lifecycle and no sync
state, and cannot express facility or staff identifiers at all, so it could not
carry HFR/HPR. Migrating it into `ExternalIdentifier` touches Phase B routes and
was judged too destabilising for this phase.

**C1 writes ABHA mappings through `ExternalIdentifier` only.** Consolidation is
tracked as follow-up work, not a defect.
