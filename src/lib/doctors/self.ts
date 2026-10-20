import { prisma } from "@/lib/db";

/**
 * Week 5a — a doctor who is also a patient (decision: a separate DoctorProfile
 * and Person, never joined). Nothing links the two rows. To keep a doctor out
 * of their own record through doctor tools, the resolvers ask, at the moment
 * of access, whether the doctor's login and the person's account are the same
 * human: the same verified contact (the doctor login's email equals the
 * person's owner email or a verified email contact). A match refuses
 * (404-shaped), and
 * nothing about the match is stored or shown.
 */
export async function isSameHuman(doctor: { userId: string }, personId: string | null): Promise<boolean> {
  if (!personId) return false;
  const doctorUser = await prisma.user.findUnique({ where: { id: doctor.userId }, select: { email: true } });
  if (!doctorUser) return false;
  const email = doctorUser.email.trim().toLowerCase();
  const owner = await prisma.personAccount.findFirst({ where: { personId, role: "OWNER" }, select: { user: { select: { email: true } } } });
  if (owner?.user.email.trim().toLowerCase() === email) return true;
  const contacts = await prisma.personContact.findMany({ where: { personId, status: "ACTIVE", verifiedAt: { not: null } }, select: { kind: true, value: true } });
  return contacts.some((c) => c.kind === "EMAIL" && c.value.toLowerCase() === email);
}

/** For a staff actor: are they a doctor reading their own person-level record? */
export async function staffIsSubject(actorUserId: string, personId: string | null): Promise<boolean> {
  if (!personId) return false;
  const d = await prisma.doctorProfile.findUnique({ where: { userId: actorUserId }, select: { userId: true } });
  return d ? isSameHuman(d, personId) : false;
}
