import type { Role } from "@prisma/client";
import type { Permission } from "../permissions";

/**
 * Phase C4 — authorization decision types.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE DISTINCTION THIS LAYER EXISTS TO ENFORCE
 *
 *   AUTHORIZATION answers: may THIS ACTOR perform THIS ACTION on THIS RESOURCE?
 *   CONSENT       answers: has THE PATIENT permitted THIS DISCLOSURE?
 *
 * They are independent. A doctor with every permission still may not disclose a
 * patient's record to an external organisation without consent. A patient's
 * consent still does not let a billing clerk read clinical notes. Neither
 * substitutes for the other, and this layer never lets one stand in for the
 * other.
 *
 * This sits ABOVE the existing RBAC — it does not replace it. requirePermission
 * and requireFacilityStaff remain the first gates; this adds the attribute,
 * purpose, consent, credential and break-glass dimensions that a role alone
 * cannot express.
 * ════════════════════════════════════════════════════════════════════════════
 */

/** Why data is being accessed. A first-class authorization input, never inferred. */
export const PURPOSES = [
  "TREATMENT",
  "REFERRAL",
  "SECOND_OPINION",
  "PATIENT_ACCESS",
  "INSURANCE",
  "RESEARCH",
  "OPERATIONS",
  "OTHER",
] as const;
export type Purpose = (typeof PURPOSES)[number];

/**
 * Sensitivity of the resource being reached. Deliberately coarse: classifying
 * individual fields would be unmaintainable and would drift from reality.
 */
export const DATA_CLASSES = [
  "STANDARD_CLINICAL",
  "SENSITIVE_CLINICAL",
  "HIGHLY_SENSITIVE",
  "FINANCIAL",
  "IDENTITY",
  "SECURITY",
] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

/** How the actor relates to the patient. Derived server-side, never claimed. */
export const RELATIONSHIPS = [
  /** The patient themselves. */
  "PATIENT_SELF",
  /** An explicitly authorised delegate or guardian. */
  "AUTHORIZED_DELEGATE",
  /** Currently treating: open encounter, assignment or care team. */
  "DIRECT_CARE",
  /** Same facility, but no established care relationship. */
  "FACILITY_STAFF",
  /** Platform administration. NOT a clinical relationship. */
  "PLATFORM_ADMIN",
  /** No relationship could be established. */
  "NONE",
] as const;
export type Relationship = (typeof RELATIONSHIPS)[number];

/**
 * The decision. Deliberately richer than a boolean: "you may do this if you
 * obtain consent" and "you may do this under break-glass" are different
 * outcomes from a flat denial, and a caller needs to tell them apart to offer
 * the right next step.
 */
export const DECISIONS = [
  "ALLOW",
  "DENY",
  "REQUIRE_CONSENT",
  "REQUIRE_BREAK_GLASS",
  "REQUIRE_PRIVILEGE",
  "REQUIRE_STEP_UP_AUTH",
  /** Inputs disagree — e.g. patient belongs to another facility. */
  "CONFLICT",
] as const;
export type Decision = (typeof DECISIONS)[number];

export interface AuthorizationActor {
  userId: string;
  role: Role;
  /** Null for AAROGYA_ADMIN and patient accounts. */
  staffId: string | null;
  staffStatus: string | null;
  /** Derived from the staff profile, never from the request. */
  facilityId: string | null;
  departmentId?: string | null;
  /** Milliseconds since this session last authenticated, for step-up. */
  authAgeMs?: number | null;
}

export interface AuthorizationResource {
  /** PATIENT | ENCOUNTER | DOCUMENT | EXCHANGE | AUDIT | CONSENT | ... */
  type: string;
  id?: string | null;
  facilityId?: string | null;
  patientId?: string | null;
  encounterId?: string | null;
  /** Overrides the action's default classification for this instance. */
  dataClass?: DataClass | null;
}

export interface AuthorizationRequest {
  actor: AuthorizationActor;
  /** Key into the policy registry. Unknown actions are DENIED. */
  action: string;
  resource: AuthorizationResource;
  purpose?: Purpose | null;
  /** Local consent id, when the caller believes one applies. */
  consentId?: string | null;
  /** External recipient, for disclosure decisions. */
  recipientIdentifier?: string | null;
  /** Requested data scopes, for exchange decisions. */
  scopes?: string[];
  /** Break-glass correlation id the caller is invoking. */
  breakGlassId?: string | null;
  correlationId?: string | null;
}

export interface AuthorizationResult {
  decision: Decision;
  /** Which policy produced this. Always populated, including on denial. */
  policy: string;
  /** Operator-facing reason. Never reveals cross-facility existence. */
  reason: string;
  /** The layer that decided, for debugging and for the decision audit. */
  deniedAt?: string | null;
  relationship: Relationship;
  /** True when the allow depended on a break-glass window. */
  viaBreakGlass: boolean;
  breakGlassId?: string | null;
  /** Consent that satisfied the check, when one was required. */
  consentId?: string | null;
  /** Effective data classification of what was reached. */
  dataClass: DataClass;
  /** HTTP status the route should use. */
  httpStatus: number;
}

/**
 * What an action requires. Centralised so authorization rules live in ONE
 * readable place instead of being scattered across 300+ routes.
 */
export interface ActionPolicy {
  /** Existing RBAC permission. Still the first gate. */
  permission?: Permission;
  /** Must the actor belong to the resource's facility? Default true. */
  requireFacility?: boolean;
  /** Must an active staff profile exist? Default true for clinical actions. */
  requireActiveStaff?: boolean;
  /** Minimum relationship to the patient. */
  minimumRelationship?: Relationship;
  /** Classification of what this action reaches. */
  dataClass: DataClass;
  /** Purposes this action may be performed for. Empty = any. */
  allowedPurposes?: Purpose[];
  /** Does disclosing under this action require patient consent? */
  requireConsent?: boolean;
  /** Credential type required, when one genuinely is. */
  requiredCredentialType?: string;
  /** Clinical privilege required, when one genuinely is. */
  requiredPrivilegeType?: string;
  /** May an emergency override relax the relationship requirement? */
  breakGlassAllowed?: boolean;
  /** Require recent authentication. */
  requireStepUp?: boolean;
  /** Maximum acceptable authentication age for step-up, in ms. */
  stepUpMaxAgeMs?: number;
  /** Should every decision be audited, not just denials? */
  auditDecision?: boolean;
  /** Human description, surfaced in the authorization matrix doc. */
  description: string;
}

export function allow(args: Omit<AuthorizationResult, "decision" | "httpStatus">): AuthorizationResult {
  return { ...args, decision: "ALLOW", httpStatus: 200 };
}

const STATUS_FOR: Record<Decision, number> = {
  ALLOW: 200,
  DENY: 403,
  // Not 403: the caller can proceed by obtaining consent, and the UI needs to
  // tell those apart to offer the right next step.
  REQUIRE_CONSENT: 403,
  REQUIRE_BREAK_GLASS: 403,
  REQUIRE_PRIVILEGE: 403,
  REQUIRE_STEP_UP_AUTH: 401,
  CONFLICT: 404,
};

export function deny(
  decision: Exclude<Decision, "ALLOW">,
  args: { policy: string; reason: string; deniedAt: string; relationship?: Relationship; dataClass?: DataClass }
): AuthorizationResult {
  return {
    decision,
    policy: args.policy,
    reason: args.reason,
    deniedAt: args.deniedAt,
    relationship: args.relationship ?? "NONE",
    viaBreakGlass: false,
    dataClass: args.dataClass ?? "STANDARD_CLINICAL",
    httpStatus: STATUS_FOR[decision],
  };
}
