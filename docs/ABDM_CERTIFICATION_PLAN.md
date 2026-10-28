# ABDM certification plan (M1–M3, v3 APIs)

- **Status:** Plan only (Flagship 1d, 2026-10-28). No ABDM call has been made with a valid credential yet. Pre-launch items 5 (certification) and 20 (consent mapping) depend on this plan.
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

## 7. Open questions

1. **Is Aarogya's patient app a PHR app** in ABDM's sense (its own certification, where the patient approves consent in our app), or does the patient use ABDM's own app for approvals? That changes M1 and M3 scope a lot.
2. **Which entity applies:** Aarogya as a technology provider for many facilities, or each facility as its own integrator using our software? This affects HFR, the bridge and the agreements.
3. **ABHA creation in scope at all,** or only verifying an ABHA a person already has? Creation pulls in Aadhaar OTP flows.
4. **Scan and Share:** in scope for the first hospitals' OPD (it fits the 5c check-in)?
5. **Which care contexts** to offer: every encounter, or episodes (a whole admission, a course of antenatal visits)? Display names must carry no sensitive detail.
6. **Sensitive categories over ABDM:** 4c lets a person opt in per share. An ABDM artefact has hiTypes but no sensitive-category concept. Do we withhold sensitive records from ABDM pushes unless the person opted in locally? This plan says yes.
7. **WASA scope and auditor:** one assessment for both pre-launch item 6 and WASA, or two?
8. **Billing data:** ABDM has an invoice record type in newer IG versions (*to verify*). The local mapping marks BILLING unsupported. Revisit when the IG is re-verified.
