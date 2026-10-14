import type { PrismaClient, Prisma } from "@prisma/client";

/**
 * D8: a staff member's facility access is a FacilityMembership; their home
 * facility is the membership flagged isPrimary (at most one per user, enforced
 * by a partial unique index). Seeds and gates create staff through this.
 */
export async function ensurePrimaryMembership(
  db: PrismaClient | Prisma.TransactionClient,
  userId: string,
  facilityId: string,
  opts: { isAdmin?: boolean } = {}
) {
  const hasPrimary = await db.facilityMembership.findFirst({ where: { userId, isPrimary: true }, select: { facilityId: true } });
  const primary = !hasPrimary || hasPrimary.facilityId === facilityId;
  return db.facilityMembership.upsert({
    where: { userId_facilityId: { userId, facilityId } },
    update: { status: "ACTIVE", ...(primary ? { isPrimary: true } : {}), ...(opts.isAdmin !== undefined ? { isAdmin: opts.isAdmin } : {}) },
    create: { userId, facilityId, status: "ACTIVE", isPrimary: primary, isAdmin: opts.isAdmin ?? false },
  });
}
