import { Role, VerificationStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { NotFoundError } from "@/lib/auth/rbac";

/**
 * Scholar accounts and verification (batch 7, item 5; previously written by
 * the routes). SCHOLAR: audited, no domain events.
 */

/**
 * Creates the student's user and profile in one transaction (batch 7: a
 * failed profile left an orphan user), then records the optional
 * verification document, which puts the profile UNDER_REVIEW.
 */
export async function registerStudentAccount(input: {
  user: { email: string; passwordHash: string; displayName: string; legalName: string };
  profile: Omit<Prisma.StudentProfileUncheckedCreateInput, "userId">;
  storeDocument?: (studentProfileId: string) => Promise<{ kind: Prisma.VerificationDocumentUncheckedCreateInput["kind"]; storageRef: string; sha256: string }>;
}) {
  const { user, studentProfile } = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({ data: { ...input.user, role: Role.STUDENT } });
    const studentProfile = await tx.studentProfile.create({ data: { ...input.profile, userId: user.id } });
    return { user, studentProfile };
  });
  if (input.storeDocument) {
    const stored = await input.storeDocument(studentProfile.id);
    await prisma.$transaction([
      prisma.verificationDocument.create({ data: { studentProfileId: studentProfile.id, kind: stored.kind, storageRef: stored.storageRef, sha256: stored.sha256 } }),
      prisma.studentProfile.update({ where: { id: studentProfile.id }, data: { verificationStatus: VerificationStatus.UNDER_REVIEW } }),
    ]);
  }
  return { user, studentProfile };
}

/** An admin's verification decision on a profile (refuses an unknown profile instead of a 500). */
export async function reviewStudentVerification(input: { studentProfileId: string; approve: boolean }) {
  const status = input.approve ? VerificationStatus.VERIFIED : VerificationStatus.REJECTED;
  const r = await prisma.studentProfile.updateMany({ where: { id: input.studentProfileId }, data: { verificationStatus: status, verifiedAt: input.approve ? new Date() : null } });
  if (r.count !== 1) throw new NotFoundError("Student profile not found.");
  return status;
}

/** Dev-only shortcut (the route is gated on NODE_ENV and ENABLE_DEV_VERIFICATION). */
export async function setOwnVerificationStatusForDev(userId: string, status: VerificationStatus) {
  return prisma.studentProfile.update({ where: { userId }, data: { verificationStatus: status, verifiedAt: status === VerificationStatus.VERIFIED ? new Date() : null } });
}
