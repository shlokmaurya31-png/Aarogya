# NHCX Claims Exchange — Readiness Assessment

Phase C5. Written to be read by someone deciding whether to connect this to a
real claims network. It states what is genuinely done, what is genuinely not,
and what would be required.

**Verdict: NOT READY for NHCX connectivity. Ready for the domain work that sits
above it.**

---

## 1. What is actually implemented and verified

| Capability | State | Evidence |
|---|---|---|
| Claim package composition from canonical records | done | 111-assertion PostgreSQL gate |
| Server-derived totals (integer minor units) | done | gate §1 |
| Coverage / pre-auth / line-tracing validation | done | gate §1 |
| Document minimisation + per-document authorization | done | gate §1, §9 |
| FHIR R4 `collection` claim bundle | done | gate §2, unit tests |
| C4 authorization, consent, step-up, break-glass refusal | done | gate §3 |
| Immutable versioned submissions | done | gate §4 |
| Concurrent version race safety | done | gate §5 (PostgreSQL) |
| Idempotent dispatch | done | gate §6 (8-way race) |
| Inbound callback authentication, skew, replay | done | gate §7 (8-way race) |
| Retry classification and backoff | done | gate §8 |
| Payer query / response lifecycle | done | gate §9 |
| Settlement recording and reconciliation | done | gate §10 |
| Canonical billing integrity preserved | done | gate §11 |
| Consent withdrawal stops future disclosure | done | gate §11b |
| Tenant isolation across all seven new tables | done | gate §13 |
| Audit coverage without clinical payloads | done | gate §14 |
| **NHCX transport** | **NOT IMPLEMENTED** | §2 |

---

## 2. Why transport is not implemented

This is a deliberate, load-bearing decision, not unfinished work.

Sources consulted (full record in
[`nhcx-contract-matrix.md`](./nhcx-contract-matrix.md)):

| Source | Result |
|---|---|
| NRCeS *Implementation Guide for Adoption of FHIR in ABDM and NHCX* (Sept 2024) | retrieved and read |
| NRCeS `hcx-profile` package | retrieved |
| `docs.hcxprotocol.io` | **HTTP 403** |
| `ig.hcxprotocol.io` | **HTTP 403** |
| `nhcx.abdm.gov.in` | client-rendered; publishes no specification content |

**Verified** from a primary source: FHIR version `4.0.1`; claim bundle type
`collection`; the profile list; required Bundle elements.

**Not verified**: endpoint paths, protocol headers, the request envelope, the
callback contract, the error-code vocabulary, the crypto parameters, and the
participant-code format.

C2 committed ABDM endpoint constants only because the official PDF was read
directly. That standard is not met here. Implementing guessed request shapes for
a national claims network would produce code that looks integrated, passes its
own tests, and fails on contact with the real switch — while making every status
field in the product a lie.

So: `UnverifiedNhcxAdapter` advertises zero operations and returns
`NOT_IMPLEMENTED` from every call. Nothing in the product can report live NHCX
connectivity, and the gate asserts that (`"No exchange claims a real external
response outside the test harness"`).

---

## 3. Defects found and fixed during this phase

Found by the adversarial gate, not by review:

1. **`claim.submit` did not require step-up.** A session authenticated an hour
   earlier could compose a full clinical package, minimised and export-shaped,
   one call away from leaving the facility. Composition now carries
   `requireStepUp: true`, matching dispatch.
   *(`src/lib/auth/authorize/policies.ts`)*

2. **`retryExchange` omitted `patientId` from the authorization request.** The
   C4 engine could not evaluate consent and denied every retry with *"A patient
   is required to evaluate consent"* — a correct refusal for the wrong reason,
   which would have made retry appear permanently broken in production. The
   submission is now loaded before authorization and the patient is passed.
   *(`src/lib/hospital/nhcx/submission.ts`)*

3. **Unique index name exceeded PostgreSQL's 63-character identifier limit.**
   `ClaimSubmissionDocument_submissionId_documentId_documentVersion_key` was
   silently truncated by PostgreSQL, leaving the SQLite and PostgreSQL trees
   permanently drifted. Given an explicit short `map:` name so both agree.
   *(`prisma/schema.prisma` + both migration trees)*

---

## 4. What would be required to connect

**Blocking, and outside this codebase:**

1. Access to the authoritative HCX/NHCX protocol specification (the public hosts
   return 403).
2. NHCX participant onboarding: a participant code, credentials, and the
   sandbox endpoint set.
3. The verified callback contract: headers, signature scheme, envelope.
4. The official error-code vocabulary.
5. The crypto parameters (signing/encryption algorithms, key formats).

**Then, inside this codebase — and only this:**

1. Implement `UnverifiedNhcxAdapter.submit()` / `.checkStatus()` against the
   verified contract, or add a sibling adapter and return it from
   `getNhcxAdapter()`.
2. Replace the provisional `NHCX_ENV_VARS` names with the real onboarding
   parameter names.
3. Map the official error codes onto the existing categories in `errors.ts`.
4. Update `NHCX_CONTRACT_SOURCE.transportVerified` to `true` with the source
   recorded.
5. Run `scripts/verify-postgres-nhcx.ts` against a sandbox.

Nothing above the adapter boundary should need to change. That is the point of
the boundary.

---

## 5. Explicitly out of scope, and still out of scope

No AI adjudication. No autonomous claim approval. No fraud ML. No insurer ERP.
No accounting system. No payment gateway. No GST filing. No Aadhaar or OTP. No
PHR. No UHI. No microservices, Kafka or Kubernetes.

---

## 6. Compliance posture

This phase implements **controls**: consent-gated disclosure, purpose limitation,
data minimisation, per-document authorization, tenant isolation, immutable
audit, and integrity hashing.

Implementing controls is not the same as being compliant. No claim of DPDP,
NHCX, ABDM or any other certification is made or implied here. Compliance is a
legal and organisational determination that requires assessment of deployment,
operations, contracts and governance — none of which is in this repository.

---

## 7. Environment note

Verification ran against PostgreSQL 16.14 (Docker, `postgres:16-alpine`).
All 111 assertions passed. Both migration trees replay from zero with zero
drift. The full unit suite is 725 tests across 55 files, 0 failures.
