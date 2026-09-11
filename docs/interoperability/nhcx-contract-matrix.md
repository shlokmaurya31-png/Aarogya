# NHCX Contract Matrix

What has been **verified against an official source**, what is implemented, and
what is blocked. Nothing here is aspirational.

> **This is not a compliance or certification claim.** It records which parts of
> the NHCX/HCX contract this repository could verify and implement.

## Sources consulted

| Source | Authority | Reached | Outcome |
| --- | --- | --- | --- |
| [Implementation Guide for Adoption of FHIR in ABDM and NHCX](https://www.nrces.in/download/files/pdf/Implementation_Guide_for_Adoption_of_FHIR_in_ABDM_and_NHCX.pdf) — NRCeS/C-DAC, **September 2024** | Official (NRCeS) | ✅ PDF retrieved and text-extracted | **Data model VERIFIED** |
| [NHCX Profiles — FHIR IG for ABDM v7.0.0](https://www.nrces.in/preview/ndhm/fhir/r4/hcx-profile.html) | Official (NRCeS) | ✅ | **Profiles VERIFIED** |
| [HCX Protocol docs v0.7.1](https://docs.hcxprotocol.io/v0.7.1) | Protocol spec | ❌ **HTTP 403** | Transport UNVERIFIED |
| [HCX FHIR IG v0.7.1](https://ig.hcxprotocol.io/v0.7.1/index.html) | Protocol spec | ❌ **HTTP 403** | Transport UNVERIFIED |
| [NHCX portal](https://nhcx.abdm.gov.in/) | Official (NHA) | ⚠️ client-rendered, no spec content | Nothing extractable |

**Verified on:** 2026-09-11.

## What is VERIFIED

| Item | Value | Source |
| --- | --- | --- |
| FHIR version | **R4 — 4.0.1** | NRCeS IG, Sept 2024 |
| Claim bundle type | **`collection`** | NRCeS IG p.10 |
| Clinical document bundle type | `document` | NRCeS IG |
| Claim bundle contents | Patient, Coverage, Practitioner, Procedure, Condition grouped in a Bundle | NRCeS IG p.10 |
| Required Bundle elements | `Bundle.type`, `Bundle.timestamp`, `Bundle.identifier` | NRCeS IG p.10 |
| NHCX profiles | Coverage, CoverageEligibilityRequest/Response, Claim/ClaimResponse, Communication/CommunicationRequest, Task | NRCeS hcx-profile |
| Named bundles | ClaimBundle, ClaimResponseBundle, CoverageEligibilityRequestBundle/ResponseBundle, TaskBundle | NRCeS hcx-profile |

The direct quote that settles the bundle-type question: claim resources are
*"grouped within a Bundle of type 'Collection' to represent the complete claim
request."*

This matters — C1 built `buildDocumentBundle` for clinical exchange. Claims must
**not** use it. They use `buildCollectionBundle`.

## What is NOT VERIFIED

Both HCX protocol specification hosts returned **HTTP 403**, and the NHCX portal
serves no specification content. The following therefore have **no primary
source** and are deliberately **not implemented**:

| Item | Status |
| --- | --- |
| API endpoint paths | ❌ NOT VERIFIED |
| Protocol headers (sender/recipient code, correlation id, api call id) | ❌ NOT VERIFIED |
| Request envelope / JWE payload structure | ❌ NOT VERIFIED |
| Asynchronous `on_*` callback contract | ❌ NOT VERIFIED |
| Error code vocabulary | ❌ NOT VERIFIED |
| Signing / encryption requirements | ❌ NOT VERIFIED |
| Participant code format | ❌ NOT VERIFIED |
| Onboarding, credentials, sandbox access | ❌ BLOCKED — external |

**No endpoint path, header name or envelope shape is hardcoded anywhere in this
phase.** C2 set the precedent: those constants were only committed because the
official ABDM PDF was read directly. The same standard applies here, and it is
not met, so the transport layer stops at the adapter boundary.

## Capability matrix

Legend: **VERIFIED** (official source) · **IMPLEMENTED** (code exists, tested) ·
**PARTIAL** · **BLOCKED_EXTERNAL** · **N/A**

| Capability | Contract | Implemented | Tested | Sandbox verified | Blocker |
| --- | --- | --- | --- | --- | --- |
| Claim FHIR representation (collection bundle) | ✅ VERIFIED | ✅ | ✅ | ❌ | — |
| Coverage / Claim / ClaimResponse profiles | ✅ VERIFIED | ✅ mapped | ✅ | ❌ | — |
| Canonical claim lifecycle + state guard | N/A (internal) | ✅ | ✅ | N/A | — |
| Claim versioning / immutable submission snapshot | N/A (internal) | ✅ | ✅ | N/A | — |
| Claim document snapshot + content hash | N/A (internal) | ✅ | ✅ | N/A | — |
| Server-derived totals | N/A (internal) | ✅ | ✅ | N/A | — |
| Coverage validation before submission | N/A (internal) | ✅ | ✅ | N/A | — |
| Pre-auth lifecycle + external state mapping | PARTIAL | ✅ | ✅ | ❌ | protocol states unverified |
| Exchange record + idempotency | N/A (internal) | ✅ | ✅ | N/A | — |
| Bounded retry + failed-exchange visibility | N/A (internal) | ✅ | ✅ | N/A | — |
| Query / clarification lifecycle | PARTIAL | ✅ | ✅ | ❌ | structured reason codes unverified |
| Adjudication representation | PARTIAL | ✅ | ✅ | ❌ | decision vocabulary unverified |
| Settlement representation | PARTIAL | ✅ | ✅ | ❌ | — |
| Reconciliation exceptions | N/A (internal) | ✅ | ✅ | N/A | — |
| Resubmission / appeal | N/A (internal) | ✅ | ✅ | N/A | — |
| Callback receipt + replay protection | ❌ NOT VERIFIED | ✅ boundary only | ✅ | ❌ | contract unverified |
| **Transport: submit / status / communication** | ❌ NOT VERIFIED | ❌ **NOT IMPLEMENTED** | — | ❌ | spec 403; onboarding absent |
| **Participant registry lookup** | ❌ NOT VERIFIED | ⚠️ local mapping only | ✅ | ❌ | registry API unverified |
| **JWE encryption / signing** | ❌ NOT VERIFIED | ❌ | — | ❌ | spec 403 |

## Participant identity

Payer participant codes are stored as `ExternalIdentifier` rows with
`entityType = "PAYER"`, reusing the C1 mapping table rather than creating an
`NhcxPayer` model. A payer participant code is an external identifier for a
canonical `Payer`, which is exactly what that table already represents, and the
rows stay facility-scoped so one facility cannot read another's mapping.

## Honest status

- **ARCHITECTURE READY** — yes
- **CONTRACT READY** — data model only; transport contract unverified
- **TEST READY** — yes, against a local harness
- **SANDBOX READY** — no; transport unimplemented and no credentials exist
- **SANDBOX VERIFIED** — **no**
- **PRODUCTION READY / VERIFIED** — **no**

No NHCX network call has been made from this repository.
