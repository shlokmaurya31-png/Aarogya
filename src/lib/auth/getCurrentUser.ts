import { prisma } from "@/lib/db";
import { getSession } from "./session";

/** Server Component-friendly current-user loader. Returns null if unauthenticated. */
export async function getCurrentUser() {
  const session = await getSession();
  if (!session) return null;
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    include: {
      studentProfile: { include: { institution: true } },
      hospitalStaffProfile: { include: { department: true } },
      // D8: the home facility is the primary ACTIVE membership.
      facilityMemberships: { where: { isPrimary: true, status: "ACTIVE" }, include: { facility: true }, take: 1 },
    },
  });
  // Same revocation check as requireSession: a cookie minted before the last
  // tokenVersion bump (logout, password change, admin revoke) is dead.
  if (!user || (session.ver ?? 0) !== user.tokenVersion) return null;
  return { ...user, primaryFacility: user.facilityMemberships[0]?.facility ?? null };
}
