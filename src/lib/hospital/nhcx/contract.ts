/**
 * Phase C5 — VERIFIED NHCX contract constants.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT IS VERIFIED, AND WHAT IS DELIBERATELY ABSENT
 *
 * VERIFIED — from "Implementation Guide for Adoption of FHIR in ABDM and NHCX",
 *   NRCeS / C-DAC Pune, published September 2024, retrieved and text-extracted
 *   2026-09-11, plus the NRCeS NHCX profile index:
 *     - FHIR R4 (4.0.1)
 *     - claim/administrative exchanges use a Bundle of type "collection"
 *       (clinical documents use "document" — C1's DocumentBundle)
 *     - a claim request groups Patient, Coverage, Practitioner, Procedure and
 *       Condition inside that bundle
 *     - Bundle.type, Bundle.timestamp and Bundle.identifier are required
 *     - the NHCX profile set: Coverage, CoverageEligibilityRequest/Response,
 *       Claim/ClaimResponse, Communication/CommunicationRequest, Task
 *
 * NOT VERIFIED, THEREFORE NOT PRESENT IN THIS FILE:
 *     - endpoint paths
 *     - protocol header names
 *     - request envelope / JWE structure
 *     - the asynchronous on_* callback contract
 *     - error code vocabulary
 *     - signing and encryption parameters
 *     - participant code format
 *
 *   Both HCX protocol specification hosts (docs.hcxprotocol.io and
 *   ig.hcxprotocol.io) returned HTTP 403, and the NHCX portal serves no
 *   specification content. C2 only committed ABDM endpoint constants because
 *   the official PDF was read directly; that standard is not met here, so no
 *   endpoint, header or envelope is guessed. The transport layer stops at the
 *   adapter boundary and reports NOT_IMPLEMENTED.
 * ════════════════════════════════════════════════════════════════════════════
 */

export const NHCX_CONTRACT_SOURCE = {
  document: "Implementation Guide for Adoption of FHIR in ABDM and NHCX",
  publisher: "National Resource Centre for EHR Standards (NRCeS), C-DAC Pune",
  published: "2024-09",
  url: "https://www.nrces.in/download/files/pdf/Implementation_Guide_for_Adoption_of_FHIR_in_ABDM_and_NHCX.pdf",
  profilesUrl: "https://www.nrces.in/preview/ndhm/fhir/r4/hcx-profile.html",
  verifiedOn: "2026-09-11",
  transportVerified: false,
  transportBlockedReason:
    "HCX protocol specification hosts returned HTTP 403; no primary source for endpoints, headers, envelope, callbacks, error codes or crypto.",
} as const;

export const NHCX_FHIR_VERSION = "4.0.1" as const;

/**
 * Bundle type for claim/administrative exchange.
 *
 * This is the single most consequential verified fact in this phase: claims are
 * NOT document bundles. C1 built buildDocumentBundle for clinical exchange and
 * using it here would produce a structurally wrong payload.
 */
export const NHCX_CLAIM_BUNDLE_TYPE = "collection" as const;

/** FHIR profiles NHCX defines for claims (NRCeS profile index). */
export const NHCX_PROFILES = [
  "Coverage",
  "CoverageEligibilityRequest",
  "CoverageEligibilityResponse",
  "Claim",
  "ClaimResponse",
  "CommunicationRequest",
  "Communication",
  "Task",
] as const;

export type NhcxProfile = (typeof NHCX_PROFILES)[number];

/** Named bundles from the NRCeS profile index. */
export const NHCX_BUNDLES = [
  "ClaimBundle",
  "ClaimResponseBundle",
  "CoverageEligibilityRequestBundle",
  "CoverageEligibilityResponseBundle",
  "TaskBundle",
] as const;

/**
 * Exchange types this boundary can represent. These are OUR vocabulary for the
 * kind of interaction, not protocol operation names — those are unverified.
 */
export const NHCX_EXCHANGE_TYPES = [
  "COVERAGE_ELIGIBILITY",
  "PREAUTH",
  "CLAIM",
  "COMMUNICATION",
  "STATUS",
  "PAYMENT_NOTICE",
] as const;

export type NhcxExchangeType = (typeof NHCX_EXCHANGE_TYPES)[number];

/**
 * Adjudication outcomes we are prepared to RECEIVE and represent.
 *
 * Aarogya never computes these — it has no insurer rules and must not invent
 * any. These exist only to record what an external decision said.
 */
export const NHCX_ADJUDICATION_OUTCOMES = [
  "APPROVED",
  "PARTIALLY_APPROVED",
  "REJECTED",
  "PENDING",
  "QUERY",
] as const;

export type NhcxAdjudicationOutcome = (typeof NHCX_ADJUDICATION_OUTCOMES)[number];

/** FHIR canonical base for HL7 R4 resources used in claim bundles. */
export const FHIR_R4_BASE = "http://hl7.org/fhir" as const;

/**
 * Identifier system used for payer participant codes, stored as
 * ExternalIdentifier rows with entityType "PAYER".
 *
 * The URI is a LOCAL namespace, deliberately: the real NHCX participant
 * identifier system URI is part of the unverified transport contract, and
 * inventing an official-looking one would be worse than being honest.
 */
export const NHCX_PARTICIPANT_SYSTEM = "https://aarogya.local/nhcx/participant" as const;

/** Is the transport contract known well enough to attempt a real call? */
export function isTransportContractVerified(): boolean {
  return NHCX_CONTRACT_SOURCE.transportVerified;
}

export function describeContract() {
  return {
    ...NHCX_CONTRACT_SOURCE,
    fhirVersion: NHCX_FHIR_VERSION,
    claimBundleType: NHCX_CLAIM_BUNDLE_TYPE,
    profiles: [...NHCX_PROFILES],
    bundles: [...NHCX_BUNDLES],
  };
}
