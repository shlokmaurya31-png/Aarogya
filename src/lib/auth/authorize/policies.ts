import type { ActionPolicy } from "./types";

/**
 * Phase C4 — the action policy registry.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * DESIGN CONSTRAINTS THAT SHAPED THIS FILE
 *
 * 1. START SMALL. Phase B flagged that credential-aware authorization was never
 *    enforced on clinical routes. The tempting fix — demand a credential row
 *    for every clinical action — would deny every existing workflow, because
 *    the credentialing tables are legitimately sparse. So a credential is
 *    required ONLY where an action is genuinely high-risk AND the requirement
 *    is explicitly configured here. Absence of configuration means no
 *    requirement, never an invented one.
 *
 * 2. DENY BY DEFAULT, but only for ACTIONS. An action missing from this
 *    registry is denied outright. That is safe because it is a programming
 *    error, not a data gap.
 *
 * 3. NOT EVERYTHING IS HIGH RISK. Marking every action sensitive trains people
 *    to ignore the marking. Only a small set carries consent, privilege,
 *    step-up or break-glass requirements.
 *
 * 4. POLICIES ARE CODE. No expressions are read from the database and nothing
 *    is eval'd, so a policy cannot be altered by anyone who can write a row.
 * ════════════════════════════════════════════════════════════════════════════
 */

export const ACTION_POLICIES: Record<string, ActionPolicy> = {
  // ── Patient chart ────────────────────────────────────────────────────────
  "patient.read": {
    permission: "patient:read",
    dataClass: "STANDARD_CLINICAL",
    // FACILITY_STAFF, not DIRECT_CARE: a receptionist checking in a walk-in and
    // a covering clinician both legitimately need the chart without an open
    // encounter. Tightening this to DIRECT_CARE would break routine care, so
    // the meaningful restriction is applied to sensitive resources below.
    minimumRelationship: "FACILITY_STAFF",
    breakGlassAllowed: true,
    description: "Read a patient's demographic and summary record.",
  },
  "patient.timeline.read": {
    permission: "patient:read",
    dataClass: "SENSITIVE_CLINICAL",
    minimumRelationship: "FACILITY_STAFF",
    breakGlassAllowed: true,
    description: "Read a patient's longitudinal clinical timeline.",
  },

  // ── Documents. This is where C1's RESTRICTED gap is closed. ──────────────
  "document.read": {
    permission: "patient:read",
    dataClass: "SENSITIVE_CLINICAL",
    minimumRelationship: "FACILITY_STAFF",
    breakGlassAllowed: true,
    description: "Read clinical document metadata at the default sensitivity.",
  },
  "document.read.restricted": {
    permission: "document:manage",
    dataClass: "HIGHLY_SENSITIVE",
    // A RESTRICTED document is restricted precisely because ordinary facility
    // membership is not sufficient. Requiring DIRECT_CARE is the whole point.
    minimumRelationship: "DIRECT_CARE",
    breakGlassAllowed: true,
    auditDecision: true,
    description: "Read a RESTRICTED clinical document. Requires a care relationship.",
  },

  // ── Disclosure. Consent becomes mandatory here, not before. ──────────────
  "patient.export.fhir": {
    permission: "interop:fhir:export",
    dataClass: "HIGHLY_SENSITIVE",
    minimumRelationship: "FACILITY_STAFF",
    requireConsent: true,
    allowedPurposes: ["TREATMENT", "REFERRAL", "SECOND_OPINION", "PATIENT_ACCESS", "INSURANCE", "RESEARCH"],
    // Deliberately NOT break-glass-able. An emergency justifies reading a chart
    // locally; it does not justify transmitting a record to a third party
    // without the patient's agreement.
    breakGlassAllowed: false,
    auditDecision: true,
    description: "Compose and disclose a patient record as FHIR. Consent required.",
  },
  "exchange.request": {
    permission: "interop:exchange:request",
    dataClass: "HIGHLY_SENSITIVE",
    minimumRelationship: "FACILITY_STAFF",
    requireConsent: true,
    allowedPurposes: ["TREATMENT", "REFERRAL", "SECOND_OPINION", "INSURANCE", "RESEARCH", "PATIENT_ACCESS"],
    breakGlassAllowed: false,
    auditDecision: true,
    description: "Request an external health information exchange.",
  },
  "exchange.authorize": {
    permission: "interop:exchange:authorize",
    dataClass: "HIGHLY_SENSITIVE",
    minimumRelationship: "FACILITY_STAFF",
    requireConsent: true,
    breakGlassAllowed: false,
    requireStepUp: true,
    auditDecision: true,
    description: "Authorize an outbound disclosure to an external organisation.",
  },

  // ── Break-glass itself ───────────────────────────────────────────────────
  "breakglass.activate": {
    permission: "patient:read",
    dataClass: "SECURITY",
    // Facility membership and an active staff profile are still required —
    // break-glass relaxes the care-relationship policy, nothing else.
    minimumRelationship: "FACILITY_STAFF",
    breakGlassAllowed: false,
    auditDecision: true,
    description: "Activate a time-boxed emergency access window for one patient.",
  },
  "breakglass.review": {
    permission: "hospital:admin:manage",
    dataClass: "SECURITY",
    requireFacility: true,
    breakGlassAllowed: false,
    auditDecision: true,
    description: "Review and revoke emergency access windows for a facility.",
  },

  // ── Audit. Sensitive in its own right. ───────────────────────────────────
  "audit.read.facility": {
    permission: "hospital:admin:manage",
    dataClass: "SECURITY",
    requireFacility: true,
    breakGlassAllowed: false,
    auditDecision: true,
    description: "Read the security audit trail for one facility.",
  },
  "audit.read.platform": {
    permission: "admin:verification:manage",
    dataClass: "SECURITY",
    // Cross-facility by definition, so facility scoping cannot apply.
    requireFacility: false,
    requireActiveStaff: false,
    breakGlassAllowed: false,
    requireStepUp: true,
    auditDecision: true,
    description: "Read the platform-wide security audit trail.",
  },

  // ── Privacy requests ─────────────────────────────────────────────────────
  "privacy.request.create": {
    dataClass: "IDENTITY",
    requireActiveStaff: false,
    breakGlassAllowed: false,
    auditDecision: true,
    description: "Raise a privacy request. A patient may raise one for themselves.",
  },
  "privacy.request.read": {
    dataClass: "IDENTITY",
    requireActiveStaff: false,
    breakGlassAllowed: false,
    description: "Read privacy requests. Patients see only their own.",
  },
  "privacy.request.review": {
    permission: "hospital:admin:manage",
    dataClass: "IDENTITY",
    requireFacility: true,
    breakGlassAllowed: false,
    auditDecision: true,
    description: "Review and decide a privacy request.",
  },

  // ── Identity and credentialing. Maker/checker lives in the services. ─────
  "identity.external.link": {
    permission: "interop:identifier:manage",
    dataClass: "IDENTITY",
    minimumRelationship: "FACILITY_STAFF",
    breakGlassAllowed: false,
    auditDecision: true,
    description: "Link an external registry identifier (ABHA/HFR/HPR) to a record.",
  },
  "credential.verify": {
    permission: "credential:verify",
    dataClass: "SECURITY",
    requireFacility: true,
    breakGlassAllowed: false,
    auditDecision: true,
    description: "Verify a staff credential. Maker/checker enforced in the service.",
  },
  "privilege.grant": {
    permission: "privilege:grant",
    dataClass: "SECURITY",
    requireFacility: true,
    breakGlassAllowed: false,
    requireStepUp: true,
    auditDecision: true,
    description: "Grant a clinical privilege. Self-granting refused in the service.",
  },

  // ── Patient self-service ─────────────────────────────────────────────────
  "patient.self.read": {
    permission: "patient:self:read",
    dataClass: "STANDARD_CLINICAL",
    requireFacility: false,
    requireActiveStaff: false,
    minimumRelationship: "PATIENT_SELF",
    breakGlassAllowed: false,
    description: "A patient reading their own record.",
  },

  // ── Claims exchange (Phase C5) ───────────────────────────────────────────
  "claim.read": {
    permission: "billing:invoice:create",
    dataClass: "FINANCIAL",
    minimumRelationship: "FACILITY_STAFF",
    breakGlassAllowed: false,
    description: "Read a claim and its submission history.",
  },
  "claim.submit": {
    permission: "billing:invoice:issue",
    dataClass: "FINANCIAL",
    minimumRelationship: "FACILITY_STAFF",
    // Disclosure to a payer requires consent, exactly like any other
    // external disclosure. A claim is not an exception to C4.
    requireConsent: true,
    allowedPurposes: ["INSURANCE"],
    // An emergency justifies reading a chart. It does not justify
    // transmitting a claim to an insurer without the patient's agreement.
    breakGlassAllowed: false,
    // Composing the package is where the chart is read and minimised into an
    // export-shaped snapshot that is then one call away from leaving the
    // facility. On a session authenticated hours ago that is the same exposure
    // as transmitting it, so composition carries step-up too.
    requireStepUp: true,
    auditDecision: true,
    description: "Compose a claim submission package for an external payer.",
  },
  "claim.dispatch": {
    permission: "billing:invoice:issue",
    dataClass: "FINANCIAL",
    minimumRelationship: "FACILITY_STAFF",
    requireConsent: true,
    allowedPurposes: ["INSURANCE"],
    breakGlassAllowed: false,
    // Sending money-bearing clinical data outside the facility is the
    // highest-risk action in this phase.
    requireStepUp: true,
    auditDecision: true,
    description: "Transmit a claim submission to the external claims network.",
  },
  "claim.adjust": {
    permission: "billing:adjustment:approve",
    dataClass: "FINANCIAL",
    minimumRelationship: "FACILITY_STAFF",
    breakGlassAllowed: false,
    requireStepUp: true,
    auditDecision: true,
    description: "Manually adjust a claim amount. Maker/checker enforced in the service.",
  },
  "claim.reconcile": {
    permission: "billing:adjustment:approve",
    dataClass: "FINANCIAL",
    requireFacility: true,
    breakGlassAllowed: false,
    auditDecision: true,
    description: "Reconcile an external settlement against canonical payments.",
  },

  // ── Financial ────────────────────────────────────────────────────────────
  "billing.export": {
    permission: "billing:invoice:create",
    dataClass: "FINANCIAL",
    minimumRelationship: "FACILITY_STAFF",
    // Financial disclosure is a separate decision from clinical disclosure —
    // C1 deliberately made ALL_CLINICAL not imply BILLING, and that holds here.
    requireConsent: true,
    allowedPurposes: ["INSURANCE", "OPERATIONS", "PATIENT_ACCESS"],
    breakGlassAllowed: false,
    auditDecision: true,
    description: "Export financial records for a patient.",
  },

  // ── Phase C6 — interoperability control plane ────────────────────────────
  // These govern the CONFIGURATION of external connectivity, not clinical data,
  // so their data class is OPERATIONAL and none of them requires patient
  // consent. Every one sets breakGlassAllowed: false — an emergency is a reason
  // to read a chart, never a reason to reconfigure a national gateway, enable a
  // production integration, or silence an alert.
  "integration.read": {
    permission: "interop:overview:view",
    dataClass: "OPERATIONAL",
    requireFacility: true,
    breakGlassAllowed: false,
    description: "View integration status, readiness and exchange operations.",
  },
  "integration.configure": {
    permission: "interop:connection:manage",
    dataClass: "OPERATIONAL",
    requireFacility: true,
    breakGlassAllowed: false,
    requireStepUp: true,
    auditDecision: true,
    description: "Change integration configuration for this facility.",
  },
  "integration.enable": {
    permission: "interop:connection:manage",
    dataClass: "OPERATIONAL",
    requireFacility: true,
    breakGlassAllowed: false,
    requireStepUp: true,
    auditDecision: true,
    description: "Enable an integration. Production additionally requires approval.",
  },
  // Disabling is deliberately NOT step-up gated: it is the fail-safe direction,
  // and an operator stopping external traffic during an incident must not be
  // held up by a re-authentication prompt. It is still permissioned and audited.
  "integration.disable": {
    permission: "interop:connection:manage",
    dataClass: "OPERATIONAL",
    requireFacility: true,
    breakGlassAllowed: false,
    auditDecision: true,
    description: "Disable an integration (kill switch). Fail-safe direction.",
  },
  "integration.approveProduction": {
    permission: "interop:integration:approve",
    dataClass: "OPERATIONAL",
    requireFacility: true,
    breakGlassAllowed: false,
    requireStepUp: true,
    auditDecision: true,
    description: "Approve a facility's move to a live production environment. Checker half of maker/checker.",
  },
  "integration.participant.manage": {
    permission: "interop:participant:manage",
    dataClass: "OPERATIONAL",
    requireFacility: true,
    breakGlassAllowed: false,
    auditDecision: true,
    description: "Create or amend an external participant for this facility.",
  },
  "integration.participant.verify": {
    permission: "interop:participant:verify",
    dataClass: "OPERATIONAL",
    requireFacility: true,
    breakGlassAllowed: false,
    requireStepUp: true,
    auditDecision: true,
    description: "Mark an external participant trusted, suspended or revoked.",
  },
  "integration.exchange.retry": {
    permission: "interop:exchange:retry",
    dataClass: "OPERATIONAL",
    requireFacility: true,
    breakGlassAllowed: false,
    requireStepUp: true,
    auditDecision: true,
    description: "Manually retry a failed exchange.",
  },
};

/** Default step-up freshness: re-authenticate if the session is older than this. */
export const DEFAULT_STEP_UP_MAX_AGE_MS = 15 * 60_000;

export function getActionPolicy(action: string): ActionPolicy | null {
  return ACTION_POLICIES[action] ?? null;
}

export function listActionPolicies(): { action: string; policy: ActionPolicy }[] {
  return Object.entries(ACTION_POLICIES)
    .map(([action, policy]) => ({ action, policy }))
    .sort((a, b) => a.action.localeCompare(b.action));
}

/** Ordering of relationship strength, for minimum-relationship comparisons. */
const RELATIONSHIP_RANK: Record<string, number> = {
  NONE: 0,
  PLATFORM_ADMIN: 1,
  FACILITY_STAFF: 2,
  DIRECT_CARE: 3,
  AUTHORIZED_DELEGATE: 3,
  PATIENT_SELF: 4,
};

/**
 * Does the established relationship satisfy the policy?
 *
 * PLATFORM_ADMIN ranks BELOW facility staff on purpose. A platform
 * administrator manages the platform; that is not a clinical care
 * relationship, and it must not silently satisfy a clinical policy.
 */
export function relationshipSatisfies(actual: string, required: string | undefined): boolean {
  if (!required) return true;
  // PATIENT_SELF is its own axis: a patient satisfies a self policy and nothing
  // else, and no staff relationship satisfies a self policy.
  if (required === "PATIENT_SELF") return actual === "PATIENT_SELF";
  if (actual === "PATIENT_SELF") return false;
  return (RELATIONSHIP_RANK[actual] ?? 0) >= (RELATIONSHIP_RANK[required] ?? 0);
}
