/**
 * Phase C3 — ABDM protocol state, tracked separately from Aarogya's own
 * exchange lifecycle.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHY TWO STATE MACHINES
 *
 * `HealthInformationExchange.status` is what AAROGYA believes about a transfer
 * it owns. `abdmProtocolState` is what the GATEWAY last told us. They diverge
 * constantly and legitimately:
 *
 *   - an exchange authorized locally but never submitted is
 *     status=AUTHORIZED / protocol=NOT_SUBMITTED
 *   - a consent request the CM acknowledged but the patient has not answered is
 *     status=PROCESSING / protocol=ACKNOWLEDGED
 *   - a patient who denied consent is
 *     status=FAILED / protocol=DENIED  — a very different thing from a timeout
 *
 * Collapsing them would make "we never asked" indistinguishable from "they said
 * no", which is exactly the distinction a clinician and an auditor need.
 * ════════════════════════════════════════════════════════════════════════════
 */

export const ABDM_PROTOCOL_STATES = [
  /** Nothing has been sent to ABDM for this exchange. */
  "NOT_SUBMITTED",
  /** Request accepted by our transport; gateway returned 202. */
  "SUBMITTED",
  /** Gateway callback confirmed it received and validated the request. */
  "ACKNOWLEDGED",
  /** Patient approved; a consent artefact exists. */
  "GRANTED",
  /** Patient refused. Terminal, and NOT a failure to retry. */
  "DENIED",
  /** Consent artefact expired. Terminal. */
  "EXPIRED",
  /** Patient revoked after granting. Terminal. */
  "REVOKED",
  /** Gateway reported a protocol error. */
  "ERRORED",
] as const;

export type AbdmProtocolState = (typeof ABDM_PROTOCOL_STATES)[number];

/**
 * Legal protocol transitions. Deliberately strict: the gateway is an external
 * system and a malformed or replayed callback must not be able to walk a
 * terminal artefact back into a live one.
 */
export const ABDM_PROTOCOL_TRANSITIONS: Record<AbdmProtocolState, AbdmProtocolState[]> = {
  NOT_SUBMITTED: ["SUBMITTED", "ERRORED"],
  // SUBMITTED -> GRANTED is legal and NOT a skipped step. M3 §4.3.3: once the
  // patient grants consent, the CM notifies the HIU of the grant. The separate
  // on-init acknowledgement may never be observed — it can be lost, arrive out
  // of order, or be coalesced — so requiring ACKNOWLEDGED first would silently
  // drop real grants. ACKNOWLEDGED remains modelled because when we DO see it
  // the distinction is useful, but it is not a precondition.
  SUBMITTED: ["ACKNOWLEDGED", "GRANTED", "DENIED", "ERRORED", "EXPIRED"],
  ACKNOWLEDGED: ["GRANTED", "DENIED", "EXPIRED", "ERRORED"],
  GRANTED: ["REVOKED", "EXPIRED"],
  // Terminal. A patient who said no does not get overwritten by a later
  // callback claiming otherwise.
  DENIED: [],
  EXPIRED: [],
  REVOKED: [],
  // A protocol error may be retried, which resubmits.
  ERRORED: ["SUBMITTED"],
};

export function isProtocolTransitionAllowed(from: string | null | undefined, to: string): boolean {
  const current = (from ?? "NOT_SUBMITTED") as AbdmProtocolState;
  const allowed = ABDM_PROTOCOL_TRANSITIONS[current];
  if (!allowed) return false;
  return allowed.includes(to as AbdmProtocolState);
}

export function isTerminalProtocolState(state: string | null | undefined): boolean {
  const s = (state ?? "NOT_SUBMITTED") as AbdmProtocolState;
  return ABDM_PROTOCOL_TRANSITIONS[s]?.length === 0;
}

/**
 * Does this protocol state permit us to actually fetch health information?
 * Only a live GRANTED artefact does.
 */
export function protocolPermitsDataFetch(state: string | null | undefined): boolean {
  return state === "GRANTED";
}

/**
 * How a protocol state should influence the LOCAL exchange status.
 *
 * Returns null when the protocol state implies nothing about our own lifecycle
 * — most of the time the two advance independently, and forcing a local
 * transition on every callback would fight the local state machine.
 */
export function localStatusForProtocolState(state: AbdmProtocolState): string | null {
  switch (state) {
    case "DENIED":
    case "EXPIRED":
    case "REVOKED":
    case "ERRORED":
      // The transfer cannot proceed. Local lifecycle should settle to FAILED,
      // with the protocol state preserving WHY.
      return "FAILED";
    default:
      return null;
  }
}

/** Operator-facing explanation. Used by the workspace and the audit detail. */
export function describeProtocolState(state: string | null | undefined): string {
  switch (state ?? "NOT_SUBMITTED") {
    case "NOT_SUBMITTED": return "Nothing has been sent to ABDM for this exchange.";
    case "SUBMITTED": return "Submitted to the gateway; awaiting acknowledgement.";
    case "ACKNOWLEDGED": return "Gateway validated the request; awaiting the patient's decision.";
    case "GRANTED": return "The patient granted consent; a consent artefact exists.";
    case "DENIED": return "The patient declined. This is a decision, not a failure to retry.";
    case "EXPIRED": return "The consent artefact expired.";
    case "REVOKED": return "The patient revoked consent after granting it.";
    case "ERRORED": return "The gateway reported a protocol error.";
    default: return "Unknown protocol state.";
  }
}

/**
 * Map a CM-reported consent artefact status onto our protocol vocabulary.
 * An unrecognised status is NEVER coerced into a permissive one.
 */
export function protocolStateFromConsentStatus(status: string): { state: AbdmProtocolState; known: boolean } {
  switch ((status ?? "").toUpperCase()) {
    case "GRANTED": return { state: "GRANTED", known: true };
    case "DENIED": return { state: "DENIED", known: true };
    case "REVOKED": return { state: "REVOKED", known: true };
    case "EXPIRED": return { state: "EXPIRED", known: true };
    case "REQUESTED": return { state: "ACKNOWLEDGED", known: true };
    default: return { state: "ERRORED", known: false };
  }
}
