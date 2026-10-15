import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

type Db = Pick<typeof prisma, "facilityMembership" | "hospitalStaffProfile">;

/**
 * D8: FacilityMembership is the only source of staff facility access. A staff
 * member "is at" a facility when their account has an ACTIVE membership there;
 * their home facility is the one membership flagged isPrimary (at most one per
 * user, enforced by a partial unique index). The staff profile itself carries
 * no facility.
 */

/**
 * Prisma filter: staff profiles whose account has an ACTIVE membership at
 * `facilityId`. Wrapped in AND so it can be spread next to a caller's own
 * `user: { role }` filter without one replacing the other (two `user` keys in
 * one object would silently drop the facility scope).
 */
export function staffAtFacilityWhere(facilityId: string): { AND: Prisma.HospitalStaffProfileWhereInput[] } {
  return { AND: [{ user: { facilityMemberships: { some: { facilityId, status: "ACTIVE" } } } }] };
}

/** Is this staff profile at this facility (ACTIVE membership)? Unknown staff → false. */
export async function isStaffInFacility(db: Db, staffId: string, facilityId: string): Promise<boolean> {
  const n = await db.hospitalStaffProfile.count({ where: { id: staffId, ...staffAtFacilityWhere(facilityId) } });
  return n === 1;
}

/** The account's primary facility, if its primary membership is ACTIVE. */
export async function primaryFacilityIdOf(db: Db, userId: string): Promise<string | null> {
  const m = await db.facilityMembership.findFirst({ where: { userId, isPrimary: true, status: "ACTIVE" }, select: { facilityId: true } });
  return m?.facilityId ?? null;
}
