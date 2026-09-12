/**
 * Phase C6 — integration readiness model.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * READINESS IS DERIVED FROM EVIDENCE, NEVER ASSERTED.
 *
 * The single most dangerous thing this control plane could do is let a label
 * outrun reality — a dashboard that says "Ready" because somebody typed
 * PRODUCTION into a form. So nothing here stores a readiness string as truth.
 * `evaluateReadiness` takes the individual pieces of evidence and computes the
 * state, and every dimension stays independently visible.
 *
 * The dimensions are deliberately NOT collapsible into one boolean:
 *
 *   architecture  — does the adapter boundary exist at all?
 *   contract      — was the protocol verified against an official source?
 *   configuration — are the required environment values present?
 *   tests         — does an automated suite exercise it?
 *   sandbox       — has a REAL handshake succeeded against sandbox?
 *   production    — is production explicitly enabled AND approved AND verified?
 *
 * An integration can be architecturally complete, fully tested, and still
 * CONTRACT_BLOCKED — that is exactly NHCX's situation, and the model has to be
 * able to say so.
 * ════════════════════════════════════════════════════════════════════════════
 */

export const READINESS_STATES = [
  /** No environment selected, or required configuration absent. */
  "NOT_CONFIGURED",
  /** Configuration present and internally valid. Says nothing about reachability. */
  "CONFIGURED",
  /** The protocol contract was verified against an official published source. */
  "CONTRACT_VERIFIED",
  /** An automated suite exercises the integration's own logic. */
  "TEST_VERIFIED",
  /** A REAL call succeeded against the sandbox environment. */
  "SANDBOX_VERIFIED",
  /** Production selected, approved and switched on. Not yet proven. */
  "PRODUCTION_ENABLED",
  /** A REAL call succeeded against production. */
  "PRODUCTION_VERIFIED",
  /** Operator switched it off. */
  "DISABLED",
  /** Cannot progress for a reason outside this codebase. */
  "BLOCKED",
] as const;
export type ReadinessState = (typeof READINESS_STATES)[number];

export const DIMENSION_RESULTS = ["PASS", "FAIL", "BLOCKED", "NOT_APPLICABLE"] as const;
export type DimensionResult = (typeof DIMENSION_RESULTS)[number];

export interface ReadinessEvidence {
  /** The adapter boundary exists and is wired. */
  architectureComplete: boolean;
  /** Verified against an official published specification. */
  contractVerified: boolean;
  /** Why the contract could not be verified, when it could not. */
  contractBlockedReason?: string | null;
  /** Required configuration is present (never: "a secret looks plausible"). */
  configurationValid: boolean;
  configurationMissing: string[];
  /** An automated suite covers this integration. */
  testsPresent: boolean;
  environment: string;
  enabled: boolean;
  /** Timestamps set ONLY by a genuine handshake. */
  sandboxVerifiedAt: Date | null;
  productionVerifiedAt: Date | null;
  /** Maker/checker approval for going live. */
  productionApprovedAt: Date | null;
  /** Operations the adapter can genuinely perform right now. */
  liveOperations: string[];
}

export interface ReadinessAssessment {
  state: ReadinessState;
  /** Short, operator-facing. Never implies more than the evidence supports. */
  summary: string;
  dimensions: {
    architecture: DimensionResult;
    contract: DimensionResult;
    configuration: DimensionResult;
    tests: DimensionResult;
    sandbox: DimensionResult;
    production: DimensionResult;
  };
  /** Everything standing between the current state and the next one. */
  blockers: string[];
}

/**
 * Compute readiness from evidence.
 *
 * Order matters: the FIRST unmet precondition wins, so the state never skips a
 * dimension. In particular PRODUCTION_VERIFIED is unreachable without a real
 * production timestamp, and that timestamp is only ever written by a genuine
 * handshake — there is no code path that sets it from configuration.
 */
export function evaluateReadiness(e: ReadinessEvidence): ReadinessAssessment {
  const blockers: string[] = [];

  const architecture: DimensionResult = e.architectureComplete ? "PASS" : "FAIL";
  if (!e.architectureComplete) blockers.push("The adapter boundary for this integration does not exist.");

  const contract: DimensionResult = e.contractVerified ? "PASS" : "BLOCKED";
  if (!e.contractVerified) {
    blockers.push(e.contractBlockedReason || "The protocol contract has not been verified against an official source.");
  }

  const configuration: DimensionResult =
    e.environment === "DISABLED" ? "NOT_APPLICABLE" : e.configurationValid ? "PASS" : "FAIL";
  if (e.environment !== "DISABLED" && !e.configurationValid) {
    blockers.push(`Missing configuration: ${e.configurationMissing.join(", ") || "unknown"}.`);
  }

  const tests: DimensionResult = e.testsPresent ? "PASS" : "FAIL";
  if (!e.testsPresent) blockers.push("No automated suite covers this integration.");

  const sandbox: DimensionResult = e.sandboxVerifiedAt ? "PASS" : e.contractVerified ? "FAIL" : "BLOCKED";
  if (!e.sandboxVerifiedAt) {
    blockers.push("No successful call has ever been made against the sandbox environment.");
  }

  const production: DimensionResult =
    e.productionVerifiedAt ? "PASS"
      : e.environment === "PRODUCTION" && e.enabled && e.productionApprovedAt ? "FAIL"
        : "NOT_APPLICABLE";
  if (e.environment === "PRODUCTION" && !e.productionApprovedAt) {
    blockers.push("Production is selected but has not been approved by a second authorised user.");
  }

  const dimensions = { architecture, contract, configuration, tests, sandbox, production };

  // ── State selection ────────────────────────────────────────────────────────
  // Each branch is guarded by the evidence it names. There is deliberately no
  // fall-through that could land on a stronger state than the evidence allows.

  if (!e.architectureComplete) {
    return { state: "BLOCKED", summary: "No adapter exists for this integration.", dimensions, blockers };
  }

  // A disabled integration reports DISABLED regardless of how well configured
  // it is — an operator who switched it off must see that, not a green label.
  if (!e.enabled || e.environment === "DISABLED") {
    return {
      state: "DISABLED",
      summary: e.environment === "DISABLED"
        ? "No environment is selected. Nothing is transmitted."
        : "The integration is switched off. Nothing is transmitted.",
      dimensions, blockers,
    };
  }

  if (!e.contractVerified) {
    return {
      state: "BLOCKED",
      summary: e.contractBlockedReason
        || "The protocol contract could not be verified against an official source, so no transport is implemented.",
      dimensions, blockers,
    };
  }

  if (!e.configurationValid) {
    return { state: "NOT_CONFIGURED", summary: "Required configuration is missing.", dimensions, blockers };
  }

  if (e.environment === "PRODUCTION") {
    if (!e.productionApprovedAt) {
      // Selected but never approved. Explicitly NOT a production state.
      return {
        state: "CONFIGURED",
        summary: "Production is selected but not approved. It will not dispatch.",
        dimensions, blockers,
      };
    }
    if (e.productionVerifiedAt) {
      return { state: "PRODUCTION_VERIFIED", summary: "A real call has succeeded against production.", dimensions, blockers };
    }
    return {
      state: "PRODUCTION_ENABLED",
      summary: "Production is approved and enabled, but no production call has succeeded yet.",
      dimensions, blockers,
    };
  }

  if (e.sandboxVerifiedAt) {
    return { state: "SANDBOX_VERIFIED", summary: "A real call has succeeded against the sandbox.", dimensions, blockers };
  }
  if (e.testsPresent) {
    return {
      state: "TEST_VERIFIED",
      summary: "Covered by automated tests. No external call has succeeded.",
      dimensions, blockers,
    };
  }
  if (e.contractVerified) {
    return { state: "CONTRACT_VERIFIED", summary: "Protocol contract verified. Not yet exercised.", dimensions, blockers };
  }
  return { state: "CONFIGURED", summary: "Configured.", dimensions, blockers };
}

/**
 * Is this integration permitted to make an external call right now?
 *
 * Deliberately stricter than `enabled`: a live operation also requires a
 * verified contract and valid configuration, and production additionally
 * requires approval. An operator cannot switch on their way past a missing
 * specification.
 */
export function canDispatch(e: ReadinessEvidence): { allowed: boolean; reason: string | null } {
  if (!e.architectureComplete) return { allowed: false, reason: "No adapter exists for this integration." };
  if (e.environment === "DISABLED") return { allowed: false, reason: "No environment is selected." };
  if (!e.enabled) return { allowed: false, reason: "The integration is disabled." };
  if (!e.contractVerified) {
    return { allowed: false, reason: "The protocol contract is unverified, so no transport is implemented." };
  }
  if (!e.configurationValid) {
    return { allowed: false, reason: `Missing configuration: ${e.configurationMissing.join(", ") || "unknown"}.` };
  }
  if (e.environment === "PRODUCTION" && !e.productionApprovedAt) {
    return { allowed: false, reason: "Production has not been approved by a second authorised user." };
  }
  if (e.liveOperations.length === 0) {
    // The adapter itself says it can do nothing. Believe the adapter.
    return { allowed: false, reason: "The adapter advertises no operations." };
  }
  return { allowed: true, reason: null };
}
