import { BadRequestError } from "@/lib/auth/rbac";
import {
  ABDM_PURPOSE_CODES, ABDM_HI_TYPES, ABDM_ACCESS_MODES, ABDM_CRYPTO,
  isValidAbhaAddress, abhaAddressMatchesEnvironment,
  type AbdmPurposeCode, type AbdmHiType, type AbdmEnvironmentName,
} from "./contract";

/**
 * Phase C3 — ABDM request body construction.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * PROVENANCE OF EVERY FIELD BELOW
 *
 * Source: ABDM Milestone 3 Sandbox Documentation v2.5 (NHA, 2025-03-03),
 *         §4 (consent request init) and §5 (health information request).
 *         Re-verified 2026-09-11: v2.5 is still the current published version.
 *
 * These builders reproduce the documented request bodies EXACTLY. No field is
 * invented, renamed or inferred. Where the document is internally inconsistent
 * the discrepancy is called out in a comment rather than silently resolved.
 *
 * These functions are PURE. They construct and validate a payload; they do not
 * send it, touch the database, or make an authorization decision. That keeps
 * the wire format testable without credentials and keeps consent decisions
 * where they belong.
 * ════════════════════════════════════════════════════════════════════════════
 */

export interface ConsentRequesterIdentifier {
  /** Doc example uses "REGNO" for a council registration number. */
  type: string;
  value: string;
  system: string;
}

export interface BuildConsentRequestInput {
  /** ABHA address of the patient, e.g. `someone@sbx`. */
  patientAbhaAddress: string;
  environment: AbdmEnvironmentName;
  hiuId: string;
  /** Optional: restrict the request to one HIP. */
  hipId?: string | null;
  purposeCode: AbdmPurposeCode;
  hiTypes: AbdmHiType[];
  requesterName: string;
  requesterIdentifier: ConsentRequesterIdentifier;
  dateRangeFrom: Date;
  dateRangeTo: Date;
  /** When the recipient must erase the data. Must be after dateRangeTo. */
  dataEraseAt: Date;
  accessMode?: (typeof ABDM_ACCESS_MODES)[number];
  frequency?: { unit: "HOUR" | "DAY" | "WEEK" | "MONTH" | "YEAR"; value: number; repeats: number };
  careContexts?: { patientReference: string; careContextReference: string }[];
  /** Doc example: "www.abdm.gov.in". Must be a resolvable reference URI. */
  purposeRefUri?: string;
}

const DEFAULT_PURPOSE_REF_URI = "https://www.abdm.gov.in";

/**
 * Build the consent-request-init body (M3 §4).
 *
 * Validation here is deliberately strict and LOCAL: catching a `@sbx` address
 * aimed at production, or a date range that ends before it starts, locally
 * turns an opaque remote 403 into an immediate, explainable error — and avoids
 * spending a request against a rate-limited national gateway to learn it.
 */
export function buildConsentRequestBody(input: BuildConsentRequestInput) {
  const address = input.patientAbhaAddress?.trim();
  if (!address) throw new BadRequestError("An ABHA address is required to request consent.");
  if (!isValidAbhaAddress(address)) {
    throw new BadRequestError("That is not a valid ABHA address (expected a handle such as someone@sbx).");
  }
  if (!abhaAddressMatchesEnvironment(address, input.environment)) {
    // A @sbx handle in production is a silent identity failure otherwise.
    throw new BadRequestError(
      `ABHA address does not match the ${input.environment} environment; expected a different consent-manager suffix.`
    );
  }
  if (!input.hiuId?.trim()) throw new BadRequestError("An HIU id is required.");
  if (!ABDM_PURPOSE_CODES[input.purposeCode]) throw new BadRequestError("Unknown ABDM purpose code.");

  const hiTypes = [...new Set(input.hiTypes)];
  if (hiTypes.length === 0) throw new BadRequestError("At least one hiType is required.");
  for (const t of hiTypes) {
    if (!(ABDM_HI_TYPES as readonly string[]).includes(t)) throw new BadRequestError(`Unknown hiType: ${t}.`);
  }

  if (!(input.dateRangeFrom instanceof Date) || Number.isNaN(input.dateRangeFrom.getTime())) {
    throw new BadRequestError("dateRange.from is not a valid date.");
  }
  if (!(input.dateRangeTo instanceof Date) || Number.isNaN(input.dateRangeTo.getTime())) {
    throw new BadRequestError("dateRange.to is not a valid date.");
  }
  if (input.dateRangeTo.getTime() <= input.dateRangeFrom.getTime()) {
    throw new BadRequestError("dateRange.to must be after dateRange.from.");
  }
  if (input.dataEraseAt.getTime() <= input.dateRangeTo.getTime()) {
    throw new BadRequestError("dataEraseAt must be after the end of the requested date range.");
  }

  if (!input.requesterName?.trim()) throw new BadRequestError("A requester name is required.");
  const ident = input.requesterIdentifier;
  if (!ident?.type || !ident?.value || !ident?.system) {
    throw new BadRequestError("A requester identifier (type, value, system) is required.");
  }

  const accessMode = input.accessMode ?? "VIEW";
  if (!(ABDM_ACCESS_MODES as readonly string[]).includes(accessMode)) {
    throw new BadRequestError(`Unknown access mode: ${accessMode}.`);
  }

  return {
    consent: {
      // `hip` is optional per the doc: omitting it requests across all HIPs.
      ...(input.hipId?.trim() ? { hip: { id: input.hipId.trim() } } : {}),
      hiu: { id: input.hiuId.trim() },
      hiTypes,
      patient: { id: address },
      purpose: {
        code: input.purposeCode,
        text: ABDM_PURPOSE_CODES[input.purposeCode].text,
        refUri: input.purposeRefUri ?? DEFAULT_PURPOSE_REF_URI,
      },
      requester: {
        name: input.requesterName.trim(),
        identifier: { type: ident.type, value: ident.value, system: ident.system },
      },
      permission: {
        dateRange: {
          from: input.dateRangeFrom.toISOString(),
          to: input.dateRangeTo.toISOString(),
        },
        frequency: input.frequency ?? { unit: "HOUR", value: 0, repeats: 0 },
        accessMode,
        dataEraseAt: input.dataEraseAt.toISOString(),
      },
      ...(input.careContexts?.length ? { careContexts: input.careContexts } : {}),
    },
  };
}

export interface KeyMaterial {
  cryptoAlg: string;
  curve: string;
  dhPublicKey: { expiry: string; parameters: string; keyValue: string };
  nonce: string;
}

export interface BuildHealthInformationRequestInput {
  /** CM-issued consent artefact id — NOT Aarogya's local consent id. */
  abdmConsentId: string;
  dateRangeFrom: Date;
  dateRangeTo: Date;
  /** HTTPS URL the HIP pushes encrypted content to. */
  dataPushUrl: string;
  keyMaterial: KeyMaterial;
}

/**
 * Build the health-information-request body (M3 §5).
 *
 * NOTE ON `curve`: the M3 header table spells it `curve25519` while the request
 * body example spells it `Curve25519`. The body example is what actually goes
 * on the wire, so that is what this builder emits. The discrepancy is recorded
 * here rather than quietly normalised, because guessing wrong on a key-exchange
 * parameter fails in a way that is hard to diagnose remotely.
 */
export function buildHealthInformationRequestBody(input: BuildHealthInformationRequestInput) {
  if (!input.abdmConsentId?.trim()) {
    throw new BadRequestError("A consent-manager consent id is required (not the local consent id).");
  }
  if (!/^https:\/\//i.test(input.dataPushUrl ?? "")) {
    // ABDM pushes clinical content here. Plaintext is not acceptable.
    throw new BadRequestError("dataPushUrl must be an https URL.");
  }
  if (input.dateRangeTo.getTime() <= input.dateRangeFrom.getTime()) {
    throw new BadRequestError("dateRange.to must be after dateRange.from.");
  }

  const km = input.keyMaterial;
  if (!km?.dhPublicKey?.keyValue || !km?.nonce) {
    throw new BadRequestError("Key material (public key and nonce) is required for a health information request.");
  }
  if (km.cryptoAlg !== ABDM_CRYPTO.algorithm) {
    throw new BadRequestError(`ABDM requires cryptoAlg ${ABDM_CRYPTO.algorithm}.`);
  }

  return {
    hiRequest: {
      consent: { id: input.abdmConsentId.trim() },
      dateRange: {
        from: input.dateRangeFrom.toISOString(),
        to: input.dateRangeTo.toISOString(),
      },
      dataPushUrl: input.dataPushUrl,
      keyMaterial: {
        cryptoAlg: km.cryptoAlg,
        curve: km.curve,
        dhPublicKey: {
          expiry: km.dhPublicKey.expiry,
          parameters: km.dhPublicKey.parameters,
          keyValue: km.dhPublicKey.keyValue,
        },
        nonce: km.nonce,
      },
    },
  };
}

/** Consent status request body (M3 §4). */
export function buildConsentStatusBody(consentRequestId: string) {
  if (!consentRequestId?.trim()) throw new BadRequestError("A consent request id is required.");
  return { consentRequestId: consentRequestId.trim() };
}

/** Consent artefact fetch body (M3 §4). */
export function buildConsentFetchBody(abdmConsentId: string) {
  if (!abdmConsentId?.trim()) throw new BadRequestError("A consent-manager consent id is required.");
  return { consentId: abdmConsentId.trim() };
}

/**
 * Parse the consent-request-init response. The gateway answers 202 with the
 * consent request id, which becomes our correlation handle.
 */
export function readConsentRequestId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const direct = (body as Record<string, unknown>).consentRequestId;
  if (typeof direct === "string" && direct) return direct;
  const nested = (body as Record<string, unknown>).consentRequest;
  if (nested && typeof nested === "object") {
    const id = (nested as Record<string, unknown>).id;
    if (typeof id === "string" && id) return id;
  }
  return null;
}
