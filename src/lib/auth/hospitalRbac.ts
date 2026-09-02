import { prisma } from "@/lib/db";
import { requirePermission, ForbiddenError, UnauthorizedError } from "./rbac";
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
}

export async function requireFacilityStaff(
  permission: Permission,
  requestedFacilityId?: string
): Promise<FacilityContext> {
  const session = await requirePermission(permission);

  if (session.role === "AAROGYA_ADMIN") {
    if (!requestedFacilityId) throw new ForbiddenError(permission);
    return { session, staff: null, facilityId: requestedFacilityId };
  }

  const staff = await prisma.hospitalStaffProfile.findUnique({ where: { userId: session.userId } });
  if (!staff) throw new UnauthorizedError();
  if (staff.status !== "ACTIVE") throw new ForbiddenError(permission);

  return { session, staff, facilityId: staff.facilityId };
}
