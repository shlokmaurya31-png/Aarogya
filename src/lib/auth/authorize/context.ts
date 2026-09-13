import { prisma } from "@/lib/db";
import { requireSession } from "../rbac";
import { sessionAuthAgeMs } from "../session";
import { loadActorMemberships, canAccessFacility, TenantAccessError } from "../tenantContext";
import type { AuthorizationActor } from "./types";

/**
 * Phase C4 — build the authorization actor from the authenticated session.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THIS IS THE CHOKEPOINT FOR ACTOR IDENTITY.
 *
 * Every attribute the engine reasons about — user, role, staff id, staff
 * status, facility — is read HERE, from the session and the database. None of
 * it is ever taken from a request body, a query string, a route parameter, a
 * FHIR payload or an ABDM callback.
 *
 * That is what makes "never trust client-supplied facilityId / actorId / role"
 * enforceable rather than aspirational: there is simply no code path by which a
 * client-supplied value reaches the engine.
 *
 * `requestedFacilityId` exists solely for AAROGYA_ADMIN, which has no staff
 * profile and therefore no implicit facility. For every other role the
 * parameter is IGNORED, exactly as requireFacilityStaff already behaves.
 * ════════════════════════════════════════════════════════════════════════════
 */
export async function buildAuthorizationActor(
  requestedFacilityId?: string
): Promise<AuthorizationActor> {
  const session = await requireSession();
  const authAgeMs = sessionAuthAgeMs(session);

  if (session.role === "AAROGYA_ADMIN") {
    // Platform administration is explicitly cross-facility; the engine still
    // applies every clinical check on top of it. The organization is derived
    // for context but the platform admin is not lifecycle-gated (recovery).
    let organizationId: string | null = null;
    if (requestedFacilityId) {
      const fac = await prisma.facility.findUnique({
        where: { id: requestedFacilityId },
        select: { organizationId: true },
      });
      organizationId = fac?.organizationId ?? null;
    }
    return {
      userId: session.userId,
      role: session.role,
      staffId: null,
      staffStatus: null,
      facilityId: requestedFacilityId ?? null,
      organizationId,
      authAgeMs,
    };
  }

  const staff = await prisma.hospitalStaffProfile.findUnique({
    where: { userId: session.userId },
    select: { id: true, facilityId: true, status: true, departmentId: true },
  });

  // Phase D1 — the effective facility. A requested facility is honoured ONLY
  // when the identity has persisted membership in it (multi-facility access);
  // otherwise the home facility is used, which leaves any cross-facility
  // resource to be denied by the engine's facility-boundary check (CONFLICT).
  // Whichever facility is effective, its tenant must be ACTIVE — a suspended
  // organization or facility refuses normal operation here too, so the ten-odd
  // engine-based routes are gated exactly as the requireFacilityStaff routes.
  let effectiveFacilityId = staff?.facilityId ?? null;
  let organizationId: string | null = null;

  if (requestedFacilityId && requestedFacilityId !== staff?.facilityId) {
    const m = await loadActorMemberships(session.userId, session.role);
    const fac = await prisma.facility.findUnique({
      where: { id: requestedFacilityId },
      select: { id: true, organizationId: true },
    });
    if (fac && canAccessFacility(m, fac.id, fac.organizationId)) {
      effectiveFacilityId = fac.id;
      organizationId = fac.organizationId;
    }
  }

  if (effectiveFacilityId) {
    const fac = await prisma.facility.findUnique({
      where: { id: effectiveFacilityId },
      select: { organizationId: true, status: true, organization: { select: { status: true } } },
    });
    organizationId = fac?.organizationId ?? organizationId;
    // The facility the actor is scoped to must belong to an ACTIVE tenant.
    // (A suspended staff profile is separately handled by the engine's
    // staff-status step; this gates the tenant, not the individual.)
    if (fac) {
      if (fac.organization.status !== "ACTIVE") throw new TenantAccessError("This organization is not active.");
      if (fac.status !== "ACTIVE") throw new TenantAccessError("This facility is not active.");
    }
  }

  return {
    userId: session.userId,
    role: session.role,
    staffId: staff?.id ?? null,
    staffStatus: staff?.status ?? null,
    facilityId: effectiveFacilityId,
    organizationId,
    departmentId: staff?.departmentId ?? null,
    authAgeMs,
  };
}

/**
 * Resolve the patient a Role.PATIENT session belongs to, for self-service
 * scoping. Returns null for staff sessions.
 */
export async function resolveSelfPatient(actor: AuthorizationActor): Promise<{ id: string; facilityId: string } | null> {
  if (actor.role !== "PATIENT") return null;
  const patient = await prisma.patient.findUnique({
    where: { userId: actor.userId },
    select: { id: true, facilityId: true, mergedIntoId: true },
  });
  if (!patient) return null;
  // A merged (superseded) record must not present itself as live.
  if (patient.mergedIntoId) return null;
  return { id: patient.id, facilityId: patient.facilityId };
}
