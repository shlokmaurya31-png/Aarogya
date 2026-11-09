# ABDM certification plan (M1–M3, v3 APIs)

- **Status:** Plan (Flagship 1d, 2026-10-28); the open questions decided (2026-10-29, §7; billing data 2026-11-08). No ABDM call has been made with a valid credential yet. Pre-launch items 5 (certification) and 20 (consent mapping) depend on this plan.
- **Source of truth for what exists:** `docs/interoperability/abdm-contract-matrix.md` (verified against ABDM Milestone 3 v2.5, 2025-03-03, and the NRCeS FHIR IG 6.5.0), `abdm-architecture.md`, `abdm-sandbox-verification.md`, `abdm-production-checklist.md`. Code: `src/lib/hospital/interoperability/abdm/` and `.../fhir/`.
- **Rule carried over from Phase C:** no code is written against a guessed contract. Where this plan says *to verify*, the M1 or M2 document (or the current NHA process) hasn't been obtained, and the step starts by obtaining it.

## 1. What ABDM asks of us

ABDM certifies integrators per **milestone**, each separately:

| Milestone | Role | What it covers (summary; *to verify* against the current NHA milestone documents) |
|---|---|---|
| **M1** | Any integrator | ABHA: create an ABHA number (Aadhaar or mobile OTP flows), verify or log in with an ABHA, create or link an ABHA address, fetch the profile and card. The v3 ABHA APIs replaced the v1/v2 ones. |
| **M2** | **HIP** (a health information provider: our hospitals) | Link care contexts to a patient's ABHA (HIP-initiated, and patient-initiated discovery from a PHR app); answer consent notifications; on a health-information request, build FHIR bundles and push them **encrypted** (ECDH on Curve25519, as NHA's Fidelius library) to the requester's `dataPushUrl`; notify the consent manager. |
| **M3** | **HIU** (a health information user: our doctors and hospitals asking for records) | Raise consent requests, receive and fetch consent artefacts, request health information, receive and decrypt the push, and show it with its provenance. |

Around the milestones: **HFR** (each facility registered), **HPR** (practitioners, where a flow needs them), the **bridge** (our registered client and callback URL), and **Scan and Share** (an OPD queue token from a scanned facility QR), a separate flow that is common in hospitals. *Whether it's in scope for certification: to verify.*

Getting to production (the usual NHA path; *to verify* the current steps and order):

1. Sandbox account and client credentials.
2. Build and self-test against the sandbox, with NHA's test cases per milestone.
3. **Functional testing / demo** with NHA's team, per milestone.
4. **WASA:** a Web Application Security Assessment by a **CERT-In-empanelled auditor**, with the "safe to host" certificate and the report submitted to NHA.
5. Production onboarding (agreements, production client, HFR production entries).
6. Go-live, with monitoring and the kill switch rehearsed (`abdm-production-checklist.md` §8).

## 2. What exists today, by milestone

| Area | Built | Sandbox status | Gap |
|---|---|---|---|
| Gateway session (v3) | `abdm/session.ts` (client_credentials, in-memory token) | Contract verified live (a real `ABDM-9999` on invalid credentials) | Valid sandbox credentials |
| OpenID config, JWKS | Called | **Real sandbox pass** | — |
| Bridge callback URL registration, service lookup | Paths pinned | — | A registered bridge and a **public HTTPS callback host** (staging) |
| Error envelope | `abdm/errors.ts` | Verified against a real envelope | — |
| **M1: ABHA create, verify, address** | Registry adapter seam only; `PersonIdentifier` (hash + last 4); ABHA linking is behind `PERSON_ABHA_LINKING` (off) | — | **The M1 document; all flows; the Aadhaar handling decision (§4)** |
| **M2: care-context linking** | — | — | M2 document; linking flows; a care-context model (§3) |
| **M2: answer a health-information request** | FHIR mappers for 15 resources and a DocumentBundle (`fhir/mappers.ts`, `bundle.ts`) | n/a | **Profile validation** (`fhir/profiles.ts` is `NOT_IMPLEMENTED`: the IG StructureDefinition package isn't bundled); terminology maps; **the encrypted push (ECDH)** isn't built |
| **M3: consent request, status, fetch** | `abdm/requests.ts`, `abdm/client.ts`, protocol state machine (`abdm/protocolState.ts`) | Built, never run with credentials | Credentials and callback host |
| **M3: consent notify callback** | `abdm/callbacks.ts` (shared secret, correlation, replay guard) | — | Callback host. ABDM documents no body signature (contract matrix) |
| **M3: health-information request and receive** | Request built | — | The receive endpoint and **decryption (ECDH)** |
| Local share ↔ ABDM consent | `abdm/mapping.ts` (purposes collapse to CAREMGT; BILLING unsupported) | — | Pre-launch item 20: the review of how a 4c share maps to an artefact |
| HFR, HPR | Registry adapter seams | — | API documents not obtained |
| Security | Tenancy sweep, guards, threat models (`docs/HOSPITAL_THREAT_MODEL.md`, `docs/security/`) | — | **WASA** and pre-launch item 6 (an independent audit) |

## 3. Gaps to close, in order

1. **Obtain the documents.** The current M1 and M2 milestone documents, the ABHA v3 API reference, the HFR/HPR API references, the IG StructureDefinition package, and NHA's test-case sheets for M1–M3. Record versions and dates in the contract matrix, as Phase C did for M3.
2. **A staging callback host.** A public HTTPS URL for the bridge callbacks and `dataPushUrl`: the Supabase/Vercel staging deployment (`docs/STAGING_SUPABASE.md`), with `ABDM_CALLBACK_TOKEN` and the client secret in the environment, never in code.
3. **M3 end to end in the sandbox** (most of the code exists): register the bridge URL, raise a consent request to a sandbox ABHA, approve it in the sandbox PHR app, fetch the artefact, request health information, **build decryption** (ECDH with Curve25519 and AES-GCM, following Fidelius, tested against the sandbox's own push), display with provenance. Gate: `verify-abdm-sandbox`, which exists and reports BLOCKED without credentials; extend it per step.
4. **FHIR conformance.** Bundle the IG package, implement `validateFhirResource`, validate every bundle we build, and populate terminology maps (ICD-10, LOINC, SNOMED CT where licensed; SNOMED CT is free in India through NRCeS, *to verify*).
5. **M2 (the hospital as HIP):**
   - a **care context** model: which encounters (or episodes) are offered under an ABHA, by display name, created at discharge and visit close;
   - HIP-initiated linking at registration or discharge;
   - patient-initiated discovery (by ABHA, with the demographic match ABDM specifies; *to verify* that an exact-match rule is allowed, because this platform refuses fuzzy matches);
   - answering consent notifications;
   - building, validating and encrypting the bundles;
   - pushing and notifying.

   Consent is checked locally too: a facility answers only within the artefact's hiTypes, date range and expiry. A doctor's own record is never pushed through their tools, and sensitive categories follow the 4c rules.
6. **M1 (ABHA).** Only after the Aadhaar decision (§4):
   - ABHA verification and login first (needed to link an existing ABHA to a Person: `PersonIdentifier`, `verifiedVia = ABDM_AUTH`);
   - creation later, if the business needs it;
   - enabling `PERSON_ABHA_LINKING` only after M1 certification, per pre-launch item 5.
7. **HFR registration** of each facility, with its service id recorded per facility (`abdm-production-checklist.md` §1).
8. **WASA.** Book a CERT-In-empanelled auditor once M2/M3 are feature-complete on staging. Scope: the patient app, the Hospital OS, the doctor network, the APIs and callbacks. Fix every high and critical finding, then re-test. Do it together with pre-launch item 6, so one assessment serves both if the auditor agrees.
9. **Functional testing with NHA,** per milestone, on staging with synthetic data only.
10. **Production:** credentials in the secret manager, production HFR entries, the kill switch rehearsed, monitoring per the checklist.

## 4. Decisions this plan proposes (conservative)

1. **Order: M3 → M2 → M1.** M3 is mostly built. M2 is what hospitals need to share records. M1 brings Aadhaar handling, which raises the privacy and security bar.
2. **No Aadhaar numbers stored, ever.** ABHA creation through Aadhaar OTP passes the number to ABDM and keeps nothing (only the resulting ABHA's hash and last 4, as now). If M1 can't be certified without storing it, stop and decide.
3. **ABHA is a link, not a login,** until M1 is certified. Patients sign in with Aarogya credentials; an ABHA is an identifier on their Person.
4. **Local consent stays the source of truth inside Aarogya.** An ABDM consent artefact is an external grant, mapped onto a share (pre-launch item 20). Revoking either revokes access through both.
5. **Sandbox and staging only with synthetic data.** No real patient record goes to the sandbox, as with every other provider (`AI_REAL_DATA_ENABLED` stays off).
6. **One HIP per facility, one HIU per facility.** Aarogya acts for each facility under its own HFR id, never as one big HIP for all of them.

## 5. Sandbox steps (checklist)

- [ ] Sandbox registration on the ABDM sandbox portal; client id and secret into the staging environment.
- [ ] Session: a token with the real credentials (turns the session row in the contract matrix green).
- [ ] Bridge URL registration to the staging host; service lookup.
- [ ] A sandbox ABHA for a synthetic test person (the sandbox's test data).
- [ ] M3: consent request → approval in the sandbox PHR app → notify callback → fetch artefact → health-information request → receive push → decrypt → display.
- [ ] M2: link a care context → discover from the PHR app → consent notification → health-information request → build, validate, encrypt, push → notify.
- [ ] M1: verify an ABHA (login) → link to the Person → (creation later).
- [ ] NHA test-case sheets executed and the results recorded per milestone.
- [ ] `verify-abdm-sandbox` green for each step, in CI as a manual job (it needs credentials).

## 6. Risks

| Risk | Mitigation |
|---|---|
| The M1/M2 documents differ from what Phase C assumed | Nothing is built against them yet. Obtain them first (§3.1) |
| Crypto never exercised against the gateway | Build ECDH only against the sandbox's real push; a test vector from the sandbox before any production use |
| Fuzzy matching required for discovery | Refuse and raise it with NHA. This platform never links on a fuzzy match (Phase 0) |
| WASA findings delay go-live | Run pre-launch item 6's audit early; WASA on a feature-frozen staging build |
| ABDM outage | Already designed for: the hospital keeps working, and exchanges queue and fail visibly (`abdm-architecture.md` §8) |

## 7. Decisions (2026-10-29; were the open questions)

1. **The patient app is a PHR app** in ABDM's sense, certified later (after M2/M3): patients will approve consent in Aarogya. Until it is certified, they approve in ABDM's own app. Decided.
2. **Aarogya applies as the software vendor; each facility registers itself** (its own HFR entry, its own HIP/HIU identity, its own agreements). Decided; this matches §4.6.
3. **ABHA: verify-only for now, no creation.** No Aadhaar OTP flow is built. Decided.
4. **Scan and Share is in scope** for the first hospitals' OPD (it fits the 5c check-in). Decided; to verify its current API and certification route first (§3.1).
5. **Care contexts: OPD visits, discharge summaries, lab reports and prescriptions.** Display names carry no sensitive detail. Decided.
6. **Sensitive records are withheld from ABDM pushes unless the person opted in** locally for that category. Decided.
7. **One combined security assessment** for WASA and pre-launch item 6, if the auditor agrees; otherwise WASA first. Decided.
8. **Billing data is not shared through ABDM in M1–M3. Decided (2026-11-08).** No BILLING hiType is offered, and none is mapped from a local share (`abdm/mapping.ts` keeps BILLING unsupported). Revisit when the FHIR implementation guide is re-checked (§3.1).

## 8. Scan and Share check-in, as built with a mock gateway (Flagship 6)

Decided §7.4 (in scope for the first OPDs) and §7.3 (ABHA verify-only). Built behind the ABDM adapter, so the sandbox can be plugged in later without touching the hospital side.

- **The adapter** (`src/lib/hospital/interoperability/abdm/scanShare.ts`): the hospital needs two things from ABDM here.
  - `verifyAbha` is M1 verify-only: it never creates an ABHA, and there is no Aadhaar OTP flow.
  - `acknowledgeShare` is the on-share answer carrying the token.

  The profile the gateway delivers (`AbdmProfileShare`) follows this plan, and **its exact v3 field names are to be verified** before the sandbox adapter is written (§3.1). Only the **mock** adapter exists: `ABDM_SCAN_SHARE_MODE` other than `mock` is refused. It verifies `name@sbx` / `name@abdm` addresses, gives a synthetic 14-digit ABHA number derived from the address, and records its acknowledgements.
- **Counters and QR:** the hospital admin names counters (`POST /api/hospital/scan-share/counters`). The desk shows each counter's QR, a link signed by Aarogya that names the facility (its HIP id: the facility id until HFR registration) and the counter. A QR Aarogya didn't sign is refused.
- **The patient:** the Aarogya app stands in for the PHR app until it is certified (§7.1). They scan the QR (`/patient/scan`), confirm their ABHA address, and share. The profile is their own: name, sex, date of birth and verified phone. They get the day's token (`S-001`…) and fill in no form.
- **The hospital side** (`receiveProfileShare`, the HIP):
  - one check-in per gateway request, so a share sent twice is the same check-in;
  - the ABHA must verify;
  - the facility record is matched **only by an exact, verified ABHA number** (`ExternalIdentifier`), never by name, birth date or phone;
  - a known record goes straight into the registration queue (`QueueEntry`, `ScanShareQueued`);
  - an unknown one waits in the check-in queue (`ScanShareReceived`). The desk registers it from the shared profile or queues it for an exact UHID (`POST /api/hospital/scan-share/checkins/{id}/queue`, audited).
- **Never an Aadhaar number:** a profile carrying an Aadhaar-like number anywhere is refused whole and nothing is kept. No column can hold one. The ABHA number is kept only as a hash and its last 4.
- **Gates:** `verify-postgres-scan-share`; the browser journey `e2e/scan-share.spec.ts` (the patient scans and gets a token, then the desk registers them from the profile).
- **Not yet:** the sandbox adapter and its callback (the v3 profile-share specification first), the HFR id per facility, the patient's ABHA address remembered on their account (it is typed each time while `PERSON_ABHA_LINKING` is off).

### 8.1 Before the sandbox adapter: check the profile fields against the official v3 specification (Flagship 4e, 2026-11-09)

**Decided: the mock stays.** No sandbox or production Scan and Share adapter is written until every field below has been checked against the **official ABDM v3 specification** for the profile share (the published API reference and the sandbox's own request samples, at the version the sandbox runs). A secondary source, a blog or another vendor's SDK is not enough. Today's `AbdmProfileShare` (`src/lib/hospital/interoperability/abdm/scanShare.ts`) is our own shape, written from this plan, and none of its names is confirmed.

To check, field by field, with the result written here:

| Our field | To confirm in the v3 specification |
|---|---|
| `requestId`, `timestamp` | The request id and time headers or body fields, and which one the on-share answer must echo |
| `hipId`, `counterId` | How the scanned QR's facility (HIP / HFR id) and counter code arrive, and their format |
| `profile.abhaNumber` | The name, the format (with or without hyphens), and whether it can be absent |
| `profile.abhaAddress` | The name and suffixes (`@sbx` in the sandbox, `@abdm` in production) |
| `profile.name` | One name or name parts |
| `profile.gender` | The code set (M/F/O, or more) |
| `profile.yearOfBirth`, `monthOfBirth`, `dayOfBirth` | Separate parts, or a date; which may be absent |
| `profile.phoneNumber` | The name, the format, and whether it is verified |
| Address, district, state, pincode | Present in the share? We keep none today; decide before storing any |
| Anything carrying Aadhaar | Confirm that nothing in the share carries an Aadhaar number. Our refusal of an Aadhaar-like value anywhere in the profile stays either way |
| The on-share answer | Its endpoint, the token field, the error shape and the time limit |

The adapter is written only after that, and it maps the specification's fields onto this interface; the hospital side (`receiveProfileShare`) does not change. Until then, `ABDM_SCAN_SHARE_MODE` other than `mock` is refused, as built.
