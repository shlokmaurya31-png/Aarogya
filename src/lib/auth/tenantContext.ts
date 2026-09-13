import { prisma } from "@/lib/db";
import { NotFoundError } from "./rbac";
import type { Role } from "@prisma/client";

/**
 * A tenant-scope refusal that is NOT a missing-RBAC-permission (ForbiddenError
 * carries a Permission and formats "Missing permission: ..."). This is a plain
 * 403 whose message is safe to surface: it never reveals another tenant's
 * existence — it is only raised once membership is already established (e.g. a
 * member acting in a suspended tenant, or a member who is not an administrator).
 * withApiErrors maps any error carrying a 4xx `status` to that status.
 */
export class TenantAccessError extends Error {
  readonly status = 403 as const;
  constructor(message = "Tenant access denied.") {
    super(message);
    this.name = "TenantAccessError";
  }
}

/**
 * Phase D1 — server-side tenant context resolution.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THIS IS THE CHOKEPOINT FOR ORGANIZATION / FACILITY SCOPE.
 *
 * The effective organization and facility a request runs in are derived HERE,
 * from the authenticated identity and PERSISTED membership — never from a
 * client-supplied organizationId/facilityId in a body, query, route param or
 * client state. A client may *request* a facility; this module decides whether
 * the authenticated user may enter it, and refuses in a way that does not leak
 * whether the facility even exists.
 *
 * The layering, kept strictly separate from clinical authorization (C4):
 *
 *   TENANT scope (here)          — which organization / facility may this
 *                                  identity act in at all?
 *   CLINICAL authorization (C4)  — may this actor perform this action on this
 *                                  patient/resource?
 *
 * Neither substitutes for the other. Organization membership is NOT patient
 * consent; facility membership is NOT a clinical purpose. Break-glass, which
 * lives entirely in C4, can relax a care-relationship requirement — it can
 * NEVER move an actor across a tenant boundary, because it never reaches this
 * layer.
 *
 * Administration levels are represented as (RBAC permission) + (membership
 * admin flag), never as a new Role. `isAdmin` on a membership is scope-local:
 *   - OrganizationMembership.isAdmin → organization administrator (this org +
 *     every facility under it)
 *   - FacilityMembership.isAdmin     → facility administrator (this facility)
 *   - AAROGYA_ADMIN                  → platform administrator (cross-tenant,
 *     for platform operation / recovery), still subject to every C4 check
 * ════════════════════════════════════════════════════════════════════════════
 */

export const PLATFORM_ADMIN_ROLE: Role = "AAROGYA_ADMIN";

export interface ActorMemberships {
  userId: string;
  role: Role;
  isPlatformAdmin: boolean;
  /** ACTIVE organization memberships, keyed by organizationId. */
  orgMemberships: Map<string, { isAdmin: boolean }>;
  /** ACTIVE facility memberships, keyed by facilityId. */
  facilityMemberships: Map<string, { isAdmin: boolean; organizationId: string }>;
  /** Organizations this user administers (isAdmin org memberships). */
  adminOrgIds: Set<string>;
  /** The clinical home facility from the staff profile, if any. */
  primaryFacilityId: string | null;
}

/**
 * Load, once, everything about WHERE this identity may act. Only ACTIVE
 * memberships count — a SUSPENDED membership grants nothing. Facilities under
 * a non-ACTIVE organization are still listed here (lifecycle is enforced at the
 * point of entry, not by hiding the membership) so that a platform/org admin
 * can still administer a suspended tenant.
 */
export async function loadActorMemberships(userId: string, role: Role): Promise<ActorMemberships> {
  const isPlatformAdmin = role === PLATFORM_ADMIN_ROLE;

  const [orgRows, facRows, staff] = await Promise.all([
    prisma.organizationMembership.findMany({
      where: { userId, status: "ACTIVE" },
      select: { organizationId: true, isAdmin: true },
    }),
    prisma.facilityMembership.findMany({
      where: { userId, status: "ACTIVE" },
      select: { facilityId: true, isAdmin: true, facility: { select: { organizationId: true } } },
    }),
    prisma.hospitalStaffProfile.findUnique({
      where: { userId },
      select: { facilityId: true, status: true },
    }),
  ]);

  const orgMemberships = new Map<string, { isAdmin: boolean }>();
  const adminOrgIds = new Set<string>();
  for (const r of orgRows) {
    orgMemberships.set(r.organizationId, { isAdmin: r.isAdmin });
    if (r.isAdmin) adminOrgIds.add(r.organizationId);
  }

  const facilityMemberships = new Map<string, { isAdmin: boolean; organizationId: string }>();
  for (const r of facRows) {
    facilityMemberships.set(r.facilityId, { isAdmin: r.isAdmin, organizationId: r.facility.organizationId });
  }

  // The primary (home) facility only counts if the staff profile is active. A
  // suspended staff profile is handled by the existing RBAC/engine checks, but
  // we also refuse to treat it as an accessible default here.
  const primaryFacilityId = staff && staff.status === "ACTIVE" ? staff.facilityId : null;

  return { userId, role, isPlatformAdmin, orgMemberships, facilityMemberships, adminOrgIds, primaryFacilityId };
}

/** Is this facility one the identity may act in at all (ignoring lifecycle)? */
export function canAccessFacility(m: ActorMemberships, facilityId: string, organizationId: string): boolean {
  if (m.isPlatformAdmin) return true;
  if (m.facilityMemberships.has(facilityId)) return true;
  // An organization administrator reaches every facility under their org.
  if (m.adminOrgIds.has(organizationId)) return true;
  return false;
}

export interface ResolvedFacility {
  facilityId: string;
  organizationId: string;
  facilityAdmin: boolean;
  orgAdmin: boolean;
}

/**
 * Resolve the effective facility for a staff-scoped request.
 *
 * `requestedFacilityId` is honoured ONLY if the identity actually has standing
 * in it; otherwise the request is refused as 404-shaped so that changing an id
 * cannot be used to discover another tenant's facilities. With no requested
 * facility, the identity's home facility is used (preserving the pre-D1
 * behaviour of every existing route). A non-ACTIVE facility or organization
 * refuses normal operation for everyone except the platform administrator
 * (who operates the platform, including recovery of a suspended tenant).
 */
export async function resolveFacilityForStaff(args: {
  userId: string;
  role: Role;
  requestedFacilityId?: string | null;
}): Promise<ResolvedFacility> {
  const m = await loadActorMemberships(args.userId, args.role);

  // Platform administrator: no implicit facility, must name one; existence is
  // verified but membership is not required. Lifecycle is not enforced so the
  // platform operator can recover a suspended tenant.
  if (m.isPlatformAdmin) {
    if (!args.requestedFacilityId) throw new NotFoundError();
    const fac = await prisma.facility.findUnique({
      where: { id: args.requestedFacilityId },
      select: { id: true, organizationId: true },
    });
    if (!fac) throw new NotFoundError();
    return { facilityId: fac.id, organizationId: fac.organizationId, facilityAdmin: true, orgAdmin: true };
  }

  // Choose the target facility.
  const targetId = args.requestedFacilityId ?? m.primaryFacilityId;
  if (!targetId) {
    // Neither a requested facility nor a home facility: this identity cannot be
    // scoped to any facility. 404-shaped, consistent with cross-tenant denial.
    throw new NotFoundError();
  }

  const fac = await prisma.facility.findUnique({
    where: { id: targetId },
    select: { id: true, organizationId: true, status: true, organization: { select: { status: true } } },
  });
  // Unknown facility and inaccessible facility are reported identically.
  if (!fac || !canAccessFacility(m, fac.id, fac.organizationId)) throw new NotFoundError();

  // Lifecycle: a suspended/deactivated tenant refuses normal operation. This is
  // a 403 (you are a member; the tenant is simply not active) rather than a
  // 404 — there is nothing to enumerate, membership is already established.
  if (fac.organization.status !== "ACTIVE") throw new TenantAccessError("This organization is not active.");
  if (fac.status !== "ACTIVE") throw new TenantAccessError("This facility is not active.");

  const facMem = m.facilityMemberships.get(fac.id);
  const orgAdmin = m.adminOrgIds.has(fac.organizationId);
  return {
    facilityId: fac.id,
    organizationId: fac.organizationId,
    facilityAdmin: orgAdmin || !!facMem?.isAdmin,
    orgAdmin,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Assertions for the enterprise control plane. These operate on an already
// loaded ActorMemberships so a route can load once and assert several times.
// They throw the existing error types, so error semantics stay uniform.
// ─────────────────────────────────────────────────────────────────────────

/** The identity has standing in the organization (member or platform admin). */
export function assertOrganizationAccess(m: ActorMemberships, organizationId: string): void {
  if (m.isPlatformAdmin) return;
  if (m.orgMemberships.has(organizationId)) return;
  // 404-shaped: an outsider must not learn the organization exists.
  throw new NotFoundError();
}

/** The identity may ADMINISTER the organization. */
export function assertOrganizationAdmin(m: ActorMemberships, organizationId: string): void {
  if (m.isPlatformAdmin) return;
  // Must at least be a member (else 404 — do not confirm existence)...
  if (!m.orgMemberships.has(organizationId)) throw new NotFoundError();
  // ...and specifically an administrator of it.
  if (!m.adminOrgIds.has(organizationId)) {
    throw new TenantAccessError("Organization administration is required.");
  }
}

/** The identity may ADMINISTER the facility (facility admin, its org admin, or platform). */
export async function assertFacilityAdmin(m: ActorMemberships, facilityId: string): Promise<{ organizationId: string }> {
  const fac = await prisma.facility.findUnique({
    where: { id: facilityId },
    select: { id: true, organizationId: true },
  });
  if (!fac) throw new NotFoundError();
  if (m.isPlatformAdmin) return { organizationId: fac.organizationId };
  if (m.adminOrgIds.has(fac.organizationId)) return { organizationId: fac.organizationId };
  const facMem = m.facilityMemberships.get(facilityId);
  if (facMem?.isAdmin) return { organizationId: fac.organizationId };
  // Not a member at all → 404; a member but not an admin → 403.
  if (!facMem && !m.orgMemberships.has(fac.organizationId)) throw new NotFoundError();
  throw new TenantAccessError("Facility administration is required.");
}
