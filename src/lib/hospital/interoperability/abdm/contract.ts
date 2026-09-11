/**
 * Phase C2 — VERIFIED ABDM contract constants.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * SOURCE OF TRUTH
 *   Document : SANDBOX DOCUMENTATION (ABDM_Milestone 3), Version 2.5
 *   Created  : 2025-03-03
 *   Publisher: National Health Authority (NHA) / ABDM
 *   URL      : https://sandboxcms.abdm.gov.in/uploads/M3_Dcoument_03_03_2025_faf0c9aecb.pdf
 *   Verified : 2026-09-11
 * ════════════════════════════════════════════════════════════════════════════
 *
 * EVERY value in this file was read out of that official document. Nothing here
 * is inferred, remembered, or copied from a blog post. If a capability is not
 * in this file, it is because it could not be verified against an official
 * source — and in that case the adapter stops at the boundary and reports
 * NOT_IMPLEMENTED rather than guessing a request shape.
 *
 * Milestone 3 covers the HIU (Health Information User) side: consent request,
 * consent fetch, health-information request and the associated callbacks.
 * Milestone 1 (ABHA creation/verification) and Milestone 2 (HIP data sharing)
 * are separate documents which have NOT been verified in this phase; their
 * capabilities are recorded as EXTERNALLY BLOCKED in
 * docs/interoperability/abdm-contract-matrix.md.
 */

export const ABDM_CONTRACT_SOURCE = {
  document: "SANDBOX DOCUMENTATION (ABDM_Milestone 3)",
  version: "2.5",
  createdOn: "2025-03-03",
  url: "https://sandboxcms.abdm.gov.in/uploads/M3_Dcoument_03_03_2025_faf0c9aecb.pdf",
  verifiedOn: "2026-09-11",
  milestone: "M3 (HIU)",
} as const;

/**
 * Base URL and X-CM-ID per environment (doc §1). The consent-manager suffix is
 * NOT interchangeable: an ABHA address is `name@sbx` on sandbox and `name@abdm`
 * in production, so pointing the wrong suffix at the wrong environment produces
 * silent identity failures.
 */
export const ABDM_ENVIRONMENTS = {
  SANDBOX: { baseUrl: "https://dev.abdm.gov.in", cmId: "sbx", abhaSuffix: "@sbx" },
  PRODUCTION: { baseUrl: "https://apis.abdm.gov.in", cmId: "abdm", abhaSuffix: "@abdm" },
} as const;

export type AbdmEnvironmentName = keyof typeof ABDM_ENVIRONMENTS;

/** Endpoint paths, exactly as published (doc §3, §4, §5). */
export const ABDM_ENDPOINTS = {
  /** Gateway session / auth token (doc §3.2.1). */
  session: "/api/hiecm/gateway/v3/sessions",
  /** OpenID configuration (doc §3.2.2). */
  openIdConfiguration: "/api/hiecm/gateway/v3/.well-known/openid-configuration",
  /** JWKS used to verify gateway-issued tokens (doc §3.2.3). */
  certs: "/api/hiecm/gateway/v3/certs",
  /** Register the callback base URL for this bridge (doc §3.2.4). */
  bridgeUrl: "/api/hiecm/gateway/v3/bridge/url",
  bridgeServiceByServiceId: "/api/hiecm/gateway/v3/bridge-service/serviceId/{serviceId}",
  bridgeServices: "/api/hiecm/gateway/v3/bridge-services",
  /** Consent (HIU side) (doc §4). */
  consentRequestInit: "/api/hiecm/consent/v3/request/init",
  consentRequestStatus: "/api/hiecm/consent/v3/request/status",
  consentFetch: "/api/hiecm/consent/v3/fetch",
  consentRequestHiuOnNotify: "/api/hiecm/consent/v3/request/hiu/on-notify",
  /** Health information data flow (doc §5). */
  healthInformationRequest: "/api/hiecm/data-flow/v3/health-information/request",
  healthInformationNotify: "/api/hiecm/data-flow/v3/health-information/notify",
} as const;

/**
 * Inbound callback paths the CM calls ON US. These are appended to the callback
 * base URL registered via bridgeUrl, so they define our own route surface.
 */
export const ABDM_CALLBACK_PATHS = {
  consentRequestOnInit: "/api/v3/hiu/consent/request/on-init",
  consentRequestNotify: "/api/v3/hiu/consent/request/notify",
  consentRequestOnStatus: "/api/v3/hiu/consent/request/on-status",
  consentOnFetch: "/api/v3/hiu/consent/on-fetch",
  healthInformationOnRequest: "/api/v3/hiu/health-information/on-request",
} as const;

export type AbdmCallbackKind = keyof typeof ABDM_CALLBACK_PATHS;

/** Header names (doc §3.2.1 onwards). Case matters to the gateway. */
export const ABDM_HEADERS = {
  requestId: "REQUEST-ID",
  timestamp: "TIMESTAMP",
  cmId: "X-CM-ID",
  hiuId: "X-HIU-ID",
  hipId: "X-HIP-ID",
  authorization: "Authorization",
} as const;

/** Session request grant type (doc §3.2.1). */
export const ABDM_GRANT_TYPE = "client_credentials" as const;

/**
 * Consent purpose codes (doc §4, purpose code table). These are ABDM's
 * vocabulary, NOT Aarogya's — the local model keeps its own clinical purposes
 * and maps onto these. See abdm/mapping.ts.
 */
export const ABDM_PURPOSE_CODES = {
  CAREMGT: { code: "CAREMGT", text: "Care Management" },
  BTG: { code: "BTG", text: "Break the Glass" },
  PUBHLTH: { code: "PUBHLTH", text: "Public Health" },
  HPAYMT: { code: "HPAYMT", text: "Healthcare Payment" },
  DSRCH: { code: "DSRCH", text: "Disease Specific Healthcare Research" },
  PATRQT: { code: "PATRQT", text: "Self-Requested" },
} as const;

export type AbdmPurposeCode = keyof typeof ABDM_PURPOSE_CODES;

/**
 * hiTypes — the health-information document classes ABDM exchanges (doc §4).
 * These correspond to the ABDM FHIR IG Composition-based artefact types, which
 * is why they are document classes rather than the data-category scopes Aarogya
 * uses locally.
 */
export const ABDM_HI_TYPES = [
  "Prescription",
  "DiagnosticReport",
  "DischargeSummary",
  "ImmunizationRecord",
  "HealthDocumentRecord",
  "WellnessRecord",
  "OPConsultation",
] as const;

export type AbdmHiType = (typeof ABDM_HI_TYPES)[number];

/** Consent artefact states the CM reports back (doc §4.3.3). */
export const ABDM_CONSENT_STATES = ["REQUESTED", "GRANTED", "DENIED", "REVOKED", "EXPIRED"] as const;
export type AbdmConsentState = (typeof ABDM_CONSENT_STATES)[number];

/** Permission access mode (doc §4). VIEW is the only mode documented for HIU. */
export const ABDM_ACCESS_MODES = ["VIEW", "STORE", "QUERY", "STREAM"] as const;

/**
 * Health-information encryption parameters (doc §5). ABDM mandates ECDH key
 * agreement on curve25519; the HIU supplies an ephemeral public key and nonce,
 * and the HIP pushes encrypted content to the HIU's dataPushUrl.
 *
 * NOTE: the key-agreement implementation itself is NOT built in C2. Standing up
 * a real dataPushUrl, generating ephemeral key pairs and decrypting pushed
 * content is only meaningful once a registered bridge and callback URL exist,
 * and implementing crypto that has never been exercised against the real
 * gateway would be the exact kind of unverifiable code this phase forbids.
 */
export const ABDM_CRYPTO = {
  algorithm: "ECDH",
  curve: "curve25519",
} as const;

/**
 * ABDM error envelope (doc §4.3.2): `{"error":{"code":"ABDM-1001","message":...}}`.
 * Codes are ABDM-prefixed strings, not HTTP statuses — both are carried through
 * into the normalized error model.
 */
export const ABDM_ERROR_ENVELOPE_KEY = "error" as const;

/** Documented success statuses. The gateway answers 202 for most async flows. */
export const ABDM_SUCCESS_STATUSES = [200, 202] as const;

/**
 * Identifier shapes (doc §2).
 *   Bridge ID  — the client id NHA issues to an integrator, e.g. SBX_000135.
 *                PLATFORM-level: one per deployment, not per facility.
 *   Service ID — the facility id from the NHPR/HFR, e.g. IN02100000XX.
 *                FACILITY-level: one per registered facility.
 *
 * This distinction decides the configuration scope in config.ts and is the
 * reason ABDM credentials are NOT a per-facility setting.
 */
export const ABDM_ID_PATTERNS = {
  bridgeId: /^[A-Z]{3}_[0-9A-Z]{4,12}$/,
  serviceId: /^IN[0-9A-Z]{6,16}$/,
  /** ABHA address: a suffix-qualified handle such as `someone@sbx`. */
  abhaAddress: /^[A-Za-z0-9._-]{1,64}@[A-Za-z]{2,16}$/,
  /** ABHA number: 14 digits, commonly rendered 12-3456-7890-1234. */
  abhaNumber: /^\d{2}-?\d{4}-?\d{4}-?\d{4}$/,
} as const;

export function isValidAbhaAddress(value: string): boolean {
  return ABDM_ID_PATTERNS.abhaAddress.test(value);
}

export function isValidAbhaNumber(value: string): boolean {
  return ABDM_ID_PATTERNS.abhaNumber.test(value);
}

/**
 * An ABHA address must match the environment it is used against: a `@sbx`
 * handle is meaningless in production and vice versa. Checking this locally
 * turns a confusing remote identity failure into an immediate, explainable one.
 */
export function abhaAddressMatchesEnvironment(address: string, environment: AbdmEnvironmentName): boolean {
  return address.toLowerCase().endsWith(ABDM_ENVIRONMENTS[environment].abhaSuffix);
}

export function buildUrl(baseUrl: string, path: string, params: Record<string, string> = {}): string {
  let resolved = path;
  for (const [key, value] of Object.entries(params)) {
    resolved = resolved.replace(`{${key}}`, encodeURIComponent(value));
  }
  return `${baseUrl.replace(/\/+$/, "")}${resolved}`;
}
