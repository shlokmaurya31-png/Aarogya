# ABDM Contract Matrix

What has been **verified against an official source**, what is **implemented**,
and what is **externally blocked**. Nothing in this table is aspirational: a row
marked implemented is code that exists and is tested.

## Verified sources

| Source | Version | Published | Verified | Covers |
| --- | --- | --- | --- | --- |
| [ABDM Milestone 3 Sandbox Documentation](https://sandboxcms.abdm.gov.in/uploads/M3_Dcoument_03_03_2025_faf0c9aecb.pdf) (NHA) | 2.5 | 2025-03-03 | 2026-09-11 | Gateway session, consent (HIU), data flow, callbacks, error envelope |
| [FHIR Implementation Guide for ABDM](https://nrces.in/ndhm/fhir/r4/) (NRCeS) | 6.5.0 | — | 2026-09-11 | FHIR R4 4.0.1 profiles, DocumentBundle, artefact types |

**FHIR version: R4 (4.0.1)** — mandated by the ABDM IG, not chosen.

**Not obtained:** ABDM Milestone 1 (ABHA creation/verification) and Milestone 2
(HIP data sharing) documents. Every capability that depends on them is marked
`CONTRACT NOT VERIFIED` below and no code was written against a guess.

## Matrix

Legend — **Contract**: is there a verified official contract?
**Adapter**: does the boundary exist? **Implemented**: is the request built and
mapped? **Sandbox**: has it run against a real ABDM environment?

| Capability | Contract | Version | Adapter | Implemented | Sandbox verified | External blocker |
| --- | --- | --- | --- | --- | --- | --- |
| Gateway session / auth token | ✅ M3 §3.2.1 | v3 | ✅ | ✅ `abdm/session.ts` | ❌ | Bridge credentials (`ABDM_CLIENT_ID`/`SECRET`) |
| OpenID configuration | ✅ M3 §3.2.2 | v3 | ✅ path pinned | ❌ not called | ❌ | Not needed until token verification is added |
| OAuth certificate (JWKS) | ✅ M3 §3.2.3 | v3 | ✅ path pinned | ❌ not called | ❌ | Only needed if gateway JWTs are verified locally |
| Bridge callback URL registration | ✅ M3 §3.2.4 | v3 | ✅ path pinned | ❌ | ❌ | Requires a registered bridge + public HTTPS callback host |
| Bridge service lookup | ✅ M3 §3.2.5 | v3 | ✅ path pinned | ❌ | ❌ | Requires registered bridge |
| Consent request init (HIU) | ✅ M3 §4 | v3 | ✅ | ⚠️ mapped, not wired | ❌ | Bridge credentials + registered HIU id |
| Consent request status | ✅ M3 §4 | v3 | ✅ path pinned | ❌ | ❌ | As above |
| Consent fetch (artefact) | ✅ M3 §4 | v3 | ✅ path pinned | ❌ | ❌ | As above |
| Consent notify callback (CM→HIU) | ✅ M3 §4.3.3 | v3 | ✅ | ✅ `abdm/callbacks.ts` | ❌ | Public HTTPS callback URL |
| Health information request | ✅ M3 §5 | v3 | ✅ | ⚠️ mapped, not wired | ❌ | Bridge credentials + `dataPushUrl` host |
| Health information data push / ECDH | ✅ M3 §5 (parameters) | v3 | ⚠️ parameters pinned | ❌ | ❌ | Needs registered `dataPushUrl`; crypto deliberately not built unexercised |
| Subscription requests | ✅ M3 §6 | v3 | ✅ paths pinned | ❌ | ❌ | Out of C2 scope |
| **ABHA creation** | ❌ **NOT VERIFIED** (M1 doc not obtained) | — | — | ❌ | ❌ | M1 specification; Aadhaar/OTP explicitly out of scope |
| **ABHA verification / discovery** | ❌ **NOT VERIFIED** | — | ✅ registry adapter | ❌ | ❌ | M1 specification |
| **ABHA linking (care contexts)** | ❌ **NOT VERIFIED** (M2) | — | — | ❌ | ❌ | M2 specification |
| **HIP data sharing** | ❌ **NOT VERIFIED** (M2) | — | — | ❌ | ❌ | M2 specification |
| **HFR** lookup / verification | ❌ **NOT VERIFIED** | — | ✅ `RegistryAdapter` | ❌ | ❌ | HFR API specification not obtained |
| **HPR** lookup / verification | ❌ **NOT VERIFIED** | — | ✅ `RegistryAdapter` | ❌ | ❌ | HPR API specification not obtained |
| FHIR R4 resource mapping | ✅ IG 6.5.0 | 4.0.1 | n/a | ✅ 15 resources | n/a | — |
| FHIR DocumentBundle | ✅ IG 6.5.0 | 4.0.1 | n/a | ✅ | n/a | — |
| FHIR **profile validation** | ✅ profiles exist | 6.5.0 | ✅ seam | ❌ `NOT_IMPLEMENTED` | ❌ | StructureDefinition package not bundled |
| Error envelope normalisation | ✅ M3 §4.3.2 | v3 | n/a | ✅ `abdm/errors.ts` | ❌ | — |
| Local ↔ ABDM consent mapping | ✅ M3 §4 vocabularies | v3 | n/a | ✅ `abdm/mapping.ts` | ❌ | — |
| Callback replay protection | ⚠️ not specified by ABDM | — | n/a | ✅ DB unique constraint | ❌ | — |
| Callback signature verification | ❌ **not specified** in M3 | — | — | ❌ | ❌ | ABDM does not document a body signature; shared secret used instead |

## Notes on the gaps that matter

**Callback authentication.** The documented CM→HIU callbacks carry only
`REQUEST-ID`, `TIMESTAMP` and `X-HIU-ID` — none of which prove origin. M3 does
not specify a signature over the callback body. Rather than invent a
cryptographic scheme, the endpoint is protected by a deployment-configured
shared secret (`ABDM_CALLBACK_TOKEN`), correlation to an exchange we actually
started, and a database-level replay guard. If ABDM later publishes a signature
scheme, it attaches at `abdm/callbacks.ts` without touching anything else.

**ECDH data push.** M3 §5 documents the key-agreement *parameters* (ECDH,
curve25519, ephemeral public key, nonce) but the flow only makes sense with a
registered `dataPushUrl` that the HIP can actually reach. Implementing and
shipping crypto that has never been exercised against the real gateway would be
exactly the unverifiable code this phase forbids, so the parameters are pinned
and the implementation is deferred.

**Purpose codes and hiTypes are ABDM's, not ours.** Aarogya's local consent
model keeps clinical purposes and data-category scopes; `abdm/mapping.ts`
translates. The mapping is lossy in a documented direction (four local purposes
collapse to `CAREMGT`) and `BILLING` has no ABDM equivalent at all, which is
reported as an unsupported scope rather than silently dropped.
