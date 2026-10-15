import { prisma } from "@/lib/db";

/**
 * Family/caregiver delegation is a patient's consent for another account to
 * see (parts of) their record. The access check lives here, in the consent
 * service, with every other consent check: the patient context
 * (src/lib/patient/context.ts) asks this for the delegations it may honour.
 * Revoked and expired delegations are filtered at read time, so revocation
 * takes effect on the very next request, regardless of any background sweep.
 */
export async function activeDelegationsTo(delegateUserId: string, now: Date = new Date()) {
  return prisma.patientDelegation.findMany({
    where: {
      delegateUserId,
      status: "ACTIVE",
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    include: { scopes: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}
