import { BadRequestError } from "@/lib/auth/rbac";
import {
  ABDM_PURPOSE_CODES, ABDM_HI_TYPES, ABDM_CONSENT_STATES,
  type AbdmPurposeCode, type AbdmHiType, type AbdmConsentState,
} from "./contract";
import type { ConsentPurpose, ConsentScope } from "../shared";

/**
 * Phase C2 — explicit mapping between Aarogya's LOCAL consent/exchange model and
 * the ABDM protocol vocabulary.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE POINT OF THIS FILE
 *
 * A local Aarogya consent row is NOT an ABDM consent artefact. They differ in
 * kind, not just in naming:
 *
 *   - Aarogya purposes are clinical intents (TREATMENT, REFERRAL, INSURANCE…).
 *     ABDM purposes are a fixed six-code vocabulary (CAREMGT, BTG, PUBHLTH,
 *     HPAYMT, DSRCH, PATRQT).
 *
 *   - Aarogya scopes are DATA CATEGORIES (LAB, MEDICATION, IMAGING…).
 *     ABDM hiTypes are DOCUMENT CLASSES (DiagnosticReport, Prescription,
 *     DischargeSummary…). The relationship is many-to-many, not a rename.
 *
 *   - An Aarogya consent is granted and held locally. An ABDM consent artefact
 *     is created by the Consent Manager after the PATIENT approves it in their
 *     own ABHA app, and is identified by a CM-issued consent id.
 *
 * Collapsing the two would mean either corrupting the local clinical model to
 * fit a protocol, or silently claiming ABDM semantics for a purely local
 * record. Both are wrong, so the boundary is explicit and lossy in a
 * *documented* direction.
 * ════════════════════════════════════════════════════════════════════════════
 */

/**
 * Local purpose → ABDM purpose code.
 *
 * PATIENT_ACCESS maps to PATRQT (Self-Requested) because that is exactly what
 * it is. RESEARCH maps to DSRCH, which ABDM defines narrowly as *disease
 * specific* research — recorded here so the narrowing is visible rather than
 * assumed.
 */
const PURPOSE_TO_ABDM: Record<ConsentPurpose, AbdmPurposeCode> = {
  TREATMENT: "CAREMGT",
  REFERRAL: "CAREMGT",
  SECOND_OPINION: "CAREMGT",
  INSURANCE: "HPAYMT",
  PATIENT_ACCESS: "PATRQT",
  RESEARCH: "DSRCH",
  OTHER: "CAREMGT",
};

/**
 * Purposes whose ABDM mapping LOSES meaning, and must therefore never be
 * inferred in reverse. TREATMENT, REFERRAL, SECOND_OPINION and OTHER all
 * collapse onto CAREMGT, so CAREMGT alone cannot tell you which one it was.
 */
const LOSSY_PURPOSES: ConsentPurpose[] = ["TREATMENT", "REFERRAL", "SECOND_OPINION", "OTHER"];

export function mapPurposeToAbdm(purpose: ConsentPurpose): { code: AbdmPurposeCode; text: string; lossy: boolean } {
  const code = PURPOSE_TO_ABDM[purpose];
  if (!code) throw new BadRequestError(`No ABDM purpose mapping for local purpose ${purpose}.`);
  return { code, text: ABDM_PURPOSE_CODES[code].text, lossy: LOSSY_PURPOSES.includes(purpose) };
}

/**
 * Local data-category scope → ABDM document classes.
 *
 * One local scope can require several hiTypes (a MEDICATION consent needs both
 * Prescription and OPConsultation, because prescribing is recorded in both),
 * and one hiType can serve several scopes. Expressed as a real many-to-many so
 * neither side is distorted.
 *
 * BILLING has NO hiType: ABDM's exchange vocabulary is clinical. A billing
 * consent therefore cannot be satisfied over ABDM at all, which is reported as
 * an explicit unsupported-scope error rather than silently dropped.
 */
const SCOPE_TO_HI_TYPES: Record<ConsentScope, AbdmHiType[]> = {
  ALL_CLINICAL: [...ABDM_HI_TYPES],
  DIAGNOSIS: ["OPConsultation", "DischargeSummary"],
  LAB: ["DiagnosticReport"],
  IMAGING: ["DiagnosticReport"],
  MEDICATION: ["Prescription", "OPConsultation"],
  DOCUMENTS: ["HealthDocumentRecord"],
  ENCOUNTER: ["OPConsultation", "DischargeSummary"],
  ALLERGY: ["OPConsultation"],
  VITALS: ["WellnessRecord"],
  CARE_PLAN: ["OPConsultation", "DischargeSummary"],
  BILLING: [],
};

export interface ScopeMappingResult {
  hiTypes: AbdmHiType[];
  /** Local scopes ABDM cannot express at all. */
  unsupported: ConsentScope[];
  /**
   * True when the resulting hiTypes are BROADER than the local scope asked for
   * — the caller must keep enforcing the local scope on the data it composes,
   * because the protocol cannot express the narrower request.
   */
  broadened: boolean;
}

export function mapScopesToHiTypes(scopes: ConsentScope[]): ScopeMappingResult {
  const hiTypes = new Set<AbdmHiType>();
  const unsupported: ConsentScope[] = [];
  let broadened = false;

  for (const scope of scopes) {
    const mapped = SCOPE_TO_HI_TYPES[scope];
    if (mapped === undefined) throw new BadRequestError(`No ABDM hiType mapping for local scope ${scope}.`);
    if (mapped.length === 0) { unsupported.push(scope); continue; }
    // Asking for IMAGING yields DiagnosticReport, which also carries lab data:
    // the protocol cannot separate them, so the local filter stays authoritative.
    if (scope === "IMAGING" || scope === "LAB") broadened = true;
    mapped.forEach((t) => hiTypes.add(t));
  }

  return { hiTypes: [...hiTypes], unsupported, broadened };
}

/**
 * Reverse mapping, used when reading a CM-issued artefact back. Returns the
 * FULL set of local scopes an hiType could satisfy — never a single guess.
 */
export function mapHiTypeToScopes(hiType: string): ConsentScope[] {
  const out: ConsentScope[] = [];
  for (const [scope, types] of Object.entries(SCOPE_TO_HI_TYPES) as [ConsentScope, AbdmHiType[]][]) {
    if (scope === "ALL_CLINICAL") continue;
    if ((types as string[]).includes(hiType)) out.push(scope);
  }
  return out;
}

/**
 * ABDM consent-artefact state → local consent status.
 *
 * ABDM has no equivalent of our DECLINED-vs-CANCELLED distinction, so DENIED
 * maps to DECLINED and the local CANCELLED remains a purely local outcome.
 */
const ABDM_STATE_TO_LOCAL: Record<AbdmConsentState, string> = {
  REQUESTED: "REQUESTED",
  GRANTED: "GRANTED",
  DENIED: "DECLINED",
  REVOKED: "REVOKED",
  EXPIRED: "EXPIRED",
};

export function mapAbdmConsentState(state: string): { localStatus: string; known: boolean } {
  const upper = (state ?? "").toUpperCase();
  if ((ABDM_CONSENT_STATES as readonly string[]).includes(upper)) {
    return { localStatus: ABDM_STATE_TO_LOCAL[upper as AbdmConsentState], known: true };
  }
  // An unrecognised external state must NOT be coerced into a permissive one.
  return { localStatus: "REQUESTED", known: false };
}

/**
 * Decide whether an exchange may proceed given both consent views.
 *
 * The external view WINS whenever it is more restrictive, and an unknown
 * external state blocks. A locally-GRANTED consent that the CM reports as
 * REVOKED must never authorise a transfer just because the local row is stale
 * — which is the whole point of synchronising status at authorization time.
 */
export function reconcileConsentStatus(args: {
  localStatus: string;
  externalStatus?: string | null;
  externalRequired: boolean;
}): { usable: boolean; effectiveStatus: string; reason: string | null } {
  const localUsable = ["GRANTED", "ACTIVE"].includes(args.localStatus);

  if (!args.externalRequired) {
    return localUsable
      ? { usable: true, effectiveStatus: args.localStatus, reason: null }
      : { usable: false, effectiveStatus: args.localStatus, reason: `Local consent is ${args.localStatus}.` };
  }

  if (!args.externalStatus) {
    return {
      usable: false,
      effectiveStatus: args.localStatus,
      reason: "External consent status is required for this exchange but has not been synchronised.",
    };
  }

  const mapped = mapAbdmConsentState(args.externalStatus);
  if (!mapped.known) {
    return {
      usable: false,
      effectiveStatus: args.localStatus,
      reason: `External consent status "${args.externalStatus}" is not recognised; refusing to proceed.`,
    };
  }
  const externalUsable = ["GRANTED", "ACTIVE"].includes(mapped.localStatus);
  if (!externalUsable) {
    return { usable: false, effectiveStatus: mapped.localStatus, reason: `Consent manager reports the consent as ${mapped.localStatus}.` };
  }
  if (!localUsable) {
    return { usable: false, effectiveStatus: args.localStatus, reason: `Local consent is ${args.localStatus}.` };
  }
  return { usable: true, effectiveStatus: mapped.localStatus, reason: null };
}

/**
 * Aarogya's internal exchange lifecycle is NOT the ABDM protocol state machine
 * and is deliberately kept separate (a local exchange exists before any ABDM
 * request is made, and survives after the protocol is finished). This records
 * which ABDM protocol stage a local state corresponds to, for operator display
 * and for the contract matrix.
 */
export const EXCHANGE_STATE_TO_ABDM_STAGE: Record<string, string> = {
  REQUESTED: "not yet submitted to ABDM",
  AUTHORIZED: "locally authorized, consent request not yet initiated",
  PROCESSING: "consent/data-flow request submitted, awaiting CM callback",
  COMPLETED: "health information received or delivered",
  FAILED: "failed locally or rejected by the gateway",
  REJECTED: "refused locally, never submitted",
  CANCELLED: "withdrawn locally",
};
