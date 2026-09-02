import { prisma } from "@/lib/db";
import { requirePermission, ForbiddenError } from "./rbac";
import { VerificationStatus } from "@prisma/client";
import type { Permission } from "./permissions";

/** Loads the session + StudentProfile for a permission-gated student route, requiring VERIFIED status. */
export async function requireVerifiedStudent(permission: Permission) {
  const session = await requirePermission(permission);
  const profile = await prisma.studentProfile.findUnique({ where: { userId: session.userId } });
  if (!profile) throw new ForbiddenError(permission);
  if (profile.verificationStatus !== VerificationStatus.VERIFIED) {
    throw new ForbiddenError(permission);
  }
  return { session, profile };
}
