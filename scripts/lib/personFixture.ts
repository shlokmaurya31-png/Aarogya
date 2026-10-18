import type { PrismaClient } from "@prisma/client";

/**
 * Gate fixture (Phase 0): gives a portal account its Person and an ACTIVE link
 * to a facility record the gate created for it — what sign-up does when its
 * own registration creates the record (SELF_CREATED). Patient.userId is
 * retired: a login is the patient only through such a link. Idempotent.
 */
export async function linkAccountForGate(db: PrismaClient, userId: string, patientId: string): Promise<{ personId: string; linkId: string }> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { displayName: true, email: true } });
  const acct = await db.personAccount.findUnique({ where: { userId } });
  const personId = acct?.personId ?? (await db.person.create({
    data: { displayName: user.displayName ?? "Gate person", accounts: { create: { userId, role: "OWNER" } } },
  })).id;
  const patient = await db.patient.findUniqueOrThrow({ where: { id: patientId }, select: { facilityId: true } });
  const existing = await db.personPatientLink.findFirst({ where: { personId, patientId, status: "ACTIVE" } });
  if (existing) return { personId, linkId: existing.id };
  const link = await db.personPatientLink.create({
    data: { personId, patientId, facilityId: patient.facilityId, status: "ACTIVE", method: "SELF_CREATED", linkedAt: new Date(), linkedByUserId: userId },
  });
  return { personId, linkId: link.id };
}
