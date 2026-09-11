import { prisma } from "@/lib/db";
import { roleHasPermission } from "../permissions";
import { recordAuditEvent } from "../audit";
import { getActionPolicy, relationshipSatisfies, DEFAULT_STEP_UP_MAX_AGE_MS } from "./policies";
import {
  allow, deny, type AuthorizationRequest, type AuthorizationResult,
  type Relationship, type DataClass,
} from "./types";

/**
 * Phase C4 — the centralized authorization decision engine.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * EVALUATION ORDER (deterministic, and this IS the implemented order)
 *
 *   1. action is known                → unknown action DENIES
 *   2. actor is authenticated         → caller has already proven this
 *   3. staff active where required    → suspended staff DENIED
 *   4. facility boundary              → cross-facility is CONFLICT (404-shaped)
 *   5. RBAC permission                → the existing model, still first-class
 *   6. step-up authentication         → recency of authentication
 *   7. relationship to the patient    → DIRECT_CARE / FACILITY_STAFF / SELF
 *   8. break-glass                    → may relax ONLY step 7, nothing else
 *   9. credential / privilege         → only where explicitly configured
 *  10. purpose                        → must be permitted for this action
 *  11. consent                        → only for disclosure actions
 *  12. ALLOW
 *
 * Step-up sits with the actor checks, not the resource checks. Putting it
 * after consent let a stale session probe consent state and enumerate which
 * patients have consent on file; a stale session should learn nothing.
 *
 * Every step can only DENY or narrow. Nothing later in the list can re-open
 * something an earlier step closed, which is what makes the order safe to
 * reason about.
 *
 * Facility comes BEFORE permission on purpose: a cross-facility request should
 * look identical to a nonexistent record regardless of what permissions the
 * caller holds, so the response cannot be used to probe another tenant.
 * ════════════════════════════════════════════════════════════════════════════
 */

export interface AuthorizeOptions {
  /** Skip the decision audit. Used by bulk filters that audit once at the end. */
  skipAudit?: boolean;
  /** Injected in tests so "now" is deterministic. */
  now?: Date;
}

/**
 * Establish how the actor relates to the patient. Entirely server-derived: the
 * caller cannot assert a relationship, only have one discovered.
 */
export async function resolveRelationship(args: {
  actorUserId: string;
  actorStaffId: string | null;
  actorFacilityId: string | null;
  role: string;
  patientId?: string | null;
  facilityId?: string | null;
}): Promise<Relationship> {
  if (!args.patientId) {
    // No patient in play: the strongest meaningful relationship is membership.
    if (args.role === "AAROGYA_ADMIN") return "PLATFORM_ADMIN";
    return args.actorFacilityId ? "FACILITY_STAFF" : "NONE";
  }

  const patient = await prisma.patient.findUnique({
    where: { id: args.patientId },
    select: { id: true, facilityId: true, userId: true },
  });
  if (!patient) return "NONE";

  // The patient themselves. Checked first: a patient account must never be
  // mistaken for staff, and staff relationships must never satisfy self access.
  if (patient.userId && patient.userId === args.actorUserId) return "PATIENT_SELF";

  if (args.role === "AAROGYA_ADMIN") return "PLATFORM_ADMIN";

  // Cross-facility yields NONE regardless of role. Tenant isolation is not a
  // relationship question that seniority can answer.
  if (!args.actorFacilityId || patient.facilityId !== args.actorFacilityId) return "NONE";
  if (!args.actorStaffId) return "NONE";

  // DIRECT_CARE: an open encounter where this staff member is attending, or an
  // active nursing assignment. Deliberately narrow — "works at the hospital" is
  // FACILITY_STAFF, not a care relationship.
  const [attending, assignment] = await Promise.all([
    prisma.encounter.findFirst({
      where: {
        patientId: patient.id,
        facilityId: args.actorFacilityId,
        attendingStaffId: args.actorStaffId,
        status: { notIn: ["CLOSED", "CANCELLED"] },
      },
      select: { id: true },
    }),
    prisma.nursingAssignment.findFirst({
      // NursingAssignment has no status column: an open assignment is one
      // with no endAt. Using the real shape rather than inventing a field.
      where: { patientId: patient.id, nurseStaffId: args.actorStaffId, endAt: null },
      select: { id: true },
    }).catch(() => null),
  ]);

  if (attending || assignment) return "DIRECT_CARE";
  return "FACILITY_STAFF";
}

/** Effective classification: an instance override beats the action default. */
function effectiveDataClass(policyClass: DataClass, resourceClass?: DataClass | null): DataClass {
  return resourceClass ?? policyClass;
}

/**
 * Find a usable break-glass window for this actor and patient.
 *
 * Expiry is DERIVED from the timestamp, never trusted from the status column:
 * an unswept row that has passed its expiry is not usable, regardless of what
 * `status` still says.
 */
async function findUsableBreakGlass(args: {
  breakGlassId?: string | null;
  actorUserId: string;
  facilityId: string | null;
  patientId?: string | null;
  now: Date;
}) {
  if (!args.patientId || !args.facilityId) return null;
  const window = await prisma.breakGlassAccess.findFirst({
    where: {
      ...(args.breakGlassId ? { correlationId: args.breakGlassId } : {}),
      facilityId: args.facilityId,
      patientId: args.patientId,
      // Bound to the ACTOR who activated it. A break-glass window is not a
      // facility-wide unlock that colleagues can ride on.
      actorUserId: args.actorUserId,
      status: "ACTIVE",
      expiresAt: { gt: args.now },
    },
    orderBy: { activatedAt: "desc" },
  });
  return window;
}

/**
 * Single exit point for a decision.
 *
 * Auditing was originally only on the ALLOW path, so a DENIAL on an
 * audit-worthy action left no record unless the caller happened to use
 * requireAuthorization. That is backwards: a refused attempt to reach a
 * restricted record is MORE interesting to a security reviewer than a
 * successful one. Every decision now funnels through here.
 */
async function finish(
  request: AuthorizationRequest,
  result: AuthorizationResult,
  policy: { auditDecision?: boolean },
  options: AuthorizeOptions
): Promise<AuthorizationResult> {
  if (policy.auditDecision && !options.skipAudit) {
    await recordDecision(request, result, request.actor);
  }
  return result;
}

export async function authorizeAccess(
  request: AuthorizationRequest,
  options: AuthorizeOptions = {}
): Promise<AuthorizationResult> {
  const now = options.now ?? new Date();
  const { actor, resource } = request;

  // ── 1. Known action ──────────────────────────────────────────────────────
  const policy = getActionPolicy(request.action);
  if (!policy) {
    return deny("DENY", {
      policy: request.action,
      reason: "No authorization policy is defined for this action.",
      deniedAt: "action-registry",
    });
  }
  const dataClass = effectiveDataClass(policy.dataClass, resource.dataClass);

  // ── 3. Active staff where required ───────────────────────────────────────
  const needsStaff = policy.requireActiveStaff ?? true;
  if (needsStaff && actor.role !== "AAROGYA_ADMIN" && actor.role !== "PATIENT") {
    if (!actor.staffId) {
      return finish(request, deny("DENY", {
        policy: request.action, reason: "This action requires a staff account.",
        deniedAt: "staff-profile", dataClass,
      }), policy, options);
    }
    if (actor.staffStatus !== "ACTIVE") {
      return finish(request, deny("DENY", {
        policy: request.action, reason: "Staff account is not active.",
        deniedAt: "staff-status", dataClass,
      }), policy, options);
    }
  }

  // ── 4. Facility boundary — before permission, so it cannot be probed ─────
  const needsFacility = policy.requireFacility ?? true;
  if (needsFacility && resource.facilityId) {
    const crossFacility = !actor.facilityId || actor.facilityId !== resource.facilityId;
    // AAROGYA_ADMIN acts across facilities by design, but that is platform
    // administration and is still subject to every later clinical check.
    if (crossFacility && actor.role !== "AAROGYA_ADMIN") {
      return finish(request, deny("CONFLICT", {
        // 404-shaped: never confirms the record exists somewhere else.
        policy: request.action, reason: "Not found.",
        deniedAt: "facility-boundary", dataClass,
      }), policy, options);
    }
  }

  // ── 5. RBAC permission ───────────────────────────────────────────────────
  if (policy.permission && !roleHasPermission(actor.role, policy.permission)) {
    return finish(request, deny("DENY", {
      policy: request.action, reason: `Missing permission: ${policy.permission}`,
      deniedAt: "rbac", dataClass,
    }), policy, options);
  }

  // ── 6. Step-up authentication ────────────────────────────────────────────
  //
  // Deliberately BEFORE relationship and consent. Step-up is an ACTOR-integrity
  // check, like staff status and RBAC, and belongs with them. Evaluating it
  // after consent let a stale-but-valid session probe consent state and
  // enumerate which patients have consent on file by comparing REQUIRE_CONSENT
  // against ALLOW. A stale session should learn nothing about the resource.
  if (policy.requireStepUp) {
    const maxAge = policy.stepUpMaxAgeMs ?? DEFAULT_STEP_UP_MAX_AGE_MS;
    const age = actor.authAgeMs;
    // Unknown age is treated as too old: "we cannot tell how recently you
    // authenticated" is not evidence of a recent authentication.
    if (age === null || age === undefined || age > maxAge) {
      return finish(request, deny("REQUIRE_STEP_UP_AUTH", {
        policy: request.action,
        reason: "Re-authentication is required for this action.",
        deniedAt: "step-up", dataClass,
      }), policy, options);
    }
  }

  // ── 6. Relationship ──────────────────────────────────────────────────────
  const relationship = await resolveRelationship({
    actorUserId: actor.userId,
    actorStaffId: actor.staffId,
    actorFacilityId: actor.facilityId,
    role: actor.role,
    patientId: resource.patientId,
    facilityId: resource.facilityId,
  });

  if (resource.patientId && relationship === "NONE") {
    return finish(request, deny("CONFLICT", {
      policy: request.action, reason: "Not found.",
      deniedAt: "patient-relationship", relationship, dataClass,
    }), policy, options);
  }

  let viaBreakGlass = false;
  let breakGlassId: string | null = null;

  if (!relationshipSatisfies(relationship, policy.minimumRelationship)) {
    // ── 7. Break-glass may relax THIS check and nothing else ───────────────
    if (policy.breakGlassAllowed) {
      const window = await findUsableBreakGlass({
        breakGlassId: request.breakGlassId,
        actorUserId: actor.userId,
        facilityId: actor.facilityId,
        patientId: resource.patientId,
        now,
      });
      if (window) {
        viaBreakGlass = true;
        breakGlassId = window.correlationId;
        // Usage is counted for the abuse report. Best-effort: failing to count
        // must not deny care that policy has already permitted.
        await prisma.breakGlassAccess
          .update({ where: { id: window.id }, data: { useCount: { increment: 1 } } })
          .catch(() => undefined);
      } else {
        return finish(request, deny("REQUIRE_BREAK_GLASS", {
          policy: request.action,
          reason: "A care relationship is required. Emergency access may be requested.",
          deniedAt: "relationship", relationship, dataClass,
        }), policy, options);
      }
    } else {
      return finish(request, deny("DENY", {
        policy: request.action,
        reason: `This action requires a ${policy.minimumRelationship} relationship.`,
        deniedAt: "relationship", relationship, dataClass,
      }), policy, options);
    }
  }

  // ── 8. Credential / privilege, only where explicitly configured ──────────
  if (policy.requiredCredentialType && actor.staffId && actor.facilityId) {
    const { requireCredential } = await import("@/lib/hospital/workforce/authorization");
    try {
      await requireCredential(prisma, {
        staffId: actor.staffId, facilityId: actor.facilityId,
        credentialType: policy.requiredCredentialType,
      });
    } catch {
      return finish(request, deny("REQUIRE_PRIVILEGE", {
        policy: request.action,
        reason: `A current ${policy.requiredCredentialType} credential is required.`,
        deniedAt: "credential", relationship, dataClass,
      }), policy, options);
    }
  }
  if (policy.requiredPrivilegeType && actor.staffId && actor.facilityId) {
    const { requirePrivilege } = await import("@/lib/hospital/workforce/authorization");
    try {
      await requirePrivilege(prisma, {
        staffId: actor.staffId, facilityId: actor.facilityId,
        privilegeType: policy.requiredPrivilegeType,
      });
    } catch {
      return finish(request, deny("REQUIRE_PRIVILEGE", {
        policy: request.action,
        reason: `The ${policy.requiredPrivilegeType} clinical privilege is required.`,
        deniedAt: "privilege", relationship, dataClass,
      }), policy, options);
    }
  }

  // ── 9. Purpose ───────────────────────────────────────────────────────────
  if (policy.allowedPurposes?.length) {
    if (!request.purpose) {
      return finish(request, deny("DENY", {
        policy: request.action, reason: "A purpose of use is required for this action.",
        deniedAt: "purpose", relationship, dataClass,
      }), policy, options);
    }
    if (!policy.allowedPurposes.includes(request.purpose)) {
      return finish(request, deny("DENY", {
        policy: request.action,
        reason: `Purpose ${request.purpose} is not permitted for this action.`,
        deniedAt: "purpose", relationship, dataClass,
      }), policy, options);
    }
  }

  // ── 10. Consent — disclosure only ────────────────────────────────────────
  let consentId: string | null = null;
  if (policy.requireConsent) {
    // A patient reading their own record is not a third-party disclosure.
    const selfAccess = relationship === "PATIENT_SELF" || request.purpose === "PATIENT_ACCESS";
    if (!selfAccess) {
      if (!resource.patientId) {
        return finish(request, deny("DENY", {
          policy: request.action, reason: "A patient is required to evaluate consent.",
          deniedAt: "consent", relationship, dataClass,
        }), policy, options);
      }
      const { evaluateConsent } = await import("./consent");
      const verdict = await evaluateConsent({
        facilityId: resource.facilityId ?? actor.facilityId ?? "",
        patientId: resource.patientId,
        purpose: request.purpose ?? null,
        scopes: request.scopes ?? [],
        consentId: request.consentId ?? null,
        recipientIdentifier: request.recipientIdentifier ?? null,
        now,
      });
      if (!verdict.usable) {
        return finish(request, deny("REQUIRE_CONSENT", {
          policy: request.action, reason: verdict.reason ?? "Valid patient consent is required.",
          deniedAt: "consent", relationship, dataClass,
        }), policy, options);
      }
      consentId = verdict.consentId;
    }
  }


  // ── 12. ALLOW ────────────────────────────────────────────────────────────
  const result = allow({
    policy: request.action,
    reason: viaBreakGlass ? "Allowed under emergency access." : "Allowed.",
    relationship,
    viaBreakGlass,
    breakGlassId,
    consentId,
    dataClass,
    deniedAt: null,
  });

  return finish(request, result, policy, options);
}

/**
 * Audit an authorization decision.
 *
 * Records WHO, WHAT, WHY and the outcome — never the data reached. Actor,
 * facility and patient all come from the already-derived context, so a caller
 * cannot forge an audit entry by shaping its request.
 */
export async function recordDecision(
  request: AuthorizationRequest,
  result: AuthorizationResult,
  actor: AuthorizationRequest["actor"]
) {
  await recordAuditEvent(
    result.decision === "ALLOW" ? "security.authorization.allowed" : "security.authorization.denied",
    actor.userId,
    {
      action: request.action,
      decision: result.decision,
      policy: result.policy,
      deniedAt: result.deniedAt ?? null,
      relationship: result.relationship,
      purpose: request.purpose ?? null,
      dataClass: result.dataClass,
      viaBreakGlass: result.viaBreakGlass,
      breakGlassId: result.breakGlassId ?? null,
      consentId: result.consentId ?? null,
      resourceType: request.resource.type,
      correlationId: request.correlationId ?? null,
    },
    {
      facilityId: request.resource.facilityId ?? actor.facilityId ?? undefined,
      patientId: request.resource.patientId ?? undefined,
    }
  );
}

/**
 * Throwing wrapper for routes. Denials become the existing HTTP error types so
 * error semantics stay consistent with the rest of the API.
 */
export async function requireAuthorization(
  request: AuthorizationRequest,
  options: AuthorizeOptions = {}
): Promise<AuthorizationResult> {
  const result = await authorizeAccess(request, options);
  if (result.decision === "ALLOW") return result;

  const policy = getActionPolicy(request.action);
  if (policy?.auditDecision && !options.skipAudit) {
    await recordDecision(request, result, request.actor);
  }

  const { AuthorizationDeniedError } = await import("./errors");
  throw new AuthorizationDeniedError(result);
}
