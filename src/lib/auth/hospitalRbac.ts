import { prisma } from "@/lib/db";
import { requirePermission, requireSession, ForbiddenError, UnauthorizedError } from "./rbac";
import { resolveFacilityForStaff } from "./tenantContext";
import type { Permission } from "./permissions";
import type { HospitalStaffProfile } from "@prisma/client";

/**
 * Tenant-isolation boundary for the Hospital OS — the hospital-domain
 * analogue of Scholar's requireVerifiedStudent(). Loads the caller's
 * HospitalStaffProfile from the DB (never from anything the client sends)
 * and returns their facilityId, so every route scopes its Prisma queries
 * with `where: { facilityId }`. See
 * docs/ENTERPRISE_HOSPITAL_ARCHITECTURE.md §3 and
 * docs/HOSPITAL_THREAT_MODEL.md T-01.
 *
 * AAROGYA_ADMIN is the one role allowed to act across facilities — it has
 * no HospitalStaffProfile row, and callers must pass an explicit
 * `facilityId` (e.g. from a query param) which this function does not
 * silently trust for any other role.
 */
export interface FacilityContext {
  session: Awaited<ReturnType<typeof requirePermission>>;
  staff: HospitalStaffProfile | null;
  facilityId: string;
  /** Phase D1 — the organization that owns `facilityId` (server-derived). */
  organizationId: string;
  /** Phase D1 — is the caller an administrator OF this facility (or its org / platform)? */
  facilityAdmin: boolean;
  /** Phase D1 — is the caller an administrator of this facility's organization? */
  orgAdmin: boolean;
}

/**
 * Phase D1 — this remains THE tenant-isolation boundary for the Hospital OS,
 * now organization-aware and multi-facility capable. The facility a request
 * runs in is resolved by resolveFacilityForStaff from PERSISTED membership, so:
 *
 *   - a caller with a single facility behaves exactly as before (their home
 *     facility, no requestedFacilityId needed);
 *   - a caller who is an explicit member of several facilities may act in any
 *     of them by passing requestedFacilityId — and ONLY those;
 *   - a requestedFacilityId the caller has no standing in is refused as
 *     404-shaped, so it cannot be used to discover another tenant;
 *   - a suspended/deactivated organization or facility refuses normal operation
 *     (403), never destroying data;
 *   - AAROGYA_ADMIN still acts across facilities by naming one explicitly.
 *
 * Because ~337 routes already call this, the entire Hospital OS gains
 * multi-facility access and tenant-lifecycle enforcement without route churn.
 */
export async function requireFacilityStaff(
  permission: Permission,
  requestedFacilityId?: string
): Promise<FacilityContext> {
  const session = await requirePermission(permission);

  // Preserve the classic contracts before delegating facility resolution:
  //   - a plain non-staff caller with no requested facility is 401 (as before);
  //   - a suspended staff profile is 403 (as before).
  let staff: HospitalStaffProfile | null = null;
  if (session.role !== "AAROGYA_ADMIN") {
    staff = await prisma.hospitalStaffProfile.findUnique({ where: { userId: session.userId } });
    if (staff && staff.status !== "ACTIVE") throw new ForbiddenError(permission);
    if (!staff && !requestedFacilityId) throw new UnauthorizedError();
  }

  const resolved = await resolveFacilityForStaff({
    userId: session.userId,
    role: session.role,
    requestedFacilityId,
  });

  return {
    session,
    staff,
    facilityId: resolved.facilityId,
    organizationId: resolved.organizationId,
    facilityAdmin: resolved.facilityAdmin,
    orgAdmin: resolved.orgAdmin,
  };
}

/**
 * Phase E1 — ownership-scoped staff resolution for self-owned resources
 * (the Notification Center, and future personal "My Work" surfaces).
 *
 * Notifications are not gated by an action Permission: a staff member may
 * only ever read/mutate their OWN rows, so authorization is expressed as
 * resource ownership (recipientStaffId === the caller's staff id), enforced
 * server-side by every query in the notifications service. This helper loads
 * the caller's ACTIVE HospitalStaffProfile from the DB (never from the
 * client) and returns it alongside the session.
 *
 * A caller with no staff profile (e.g. AAROGYA_ADMIN, or a Scholar-only
 * account) is authenticated but simply owns no hospital notifications —
 * callers should treat `staff === null` as "empty stream", not an error, so
 * this never leaks another tenant's data.
 */
export interface StaffSelfContext {
  session: Awaited<ReturnType<typeof requireSession>>;
  staff: HospitalStaffProfile | null;
}

export async function requireHospitalStaffSelf(): Promise<StaffSelfContext> {
  const session = await requireSession();
  const staff = await prisma.hospitalStaffProfile.findUnique({ where: { userId: session.userId } });
  if (staff && staff.status !== "ACTIVE") throw new ForbiddenError("notification:self" as Permission);
  return { session, staff };
}
