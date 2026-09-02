import { prisma } from "@/lib/db";
import { VerificationMethod, VerificationStatus } from "@prisma/client";

/**
 * Decides the initial verification status for a new student registration.
 * This is intentionally conservative: only METHOD A (institutional email
 * matching a known, admin-managed InstitutionDomain) can auto-verify. Every
 * other method lands in a pending/review state that requires a human
 * decision (dev-only shortcuts aside — see /api/student/verification/dev).
 * Brief §4: "Do not pretend automated verification guarantees legitimacy."
 */
export async function decideInitialVerificationStatus(
  method: VerificationMethod,
  institutionEmail: string | undefined
): Promise<VerificationStatus> {
  if (method === VerificationMethod.INSTITUTIONAL_EMAIL && institutionEmail) {
    const domain = institutionEmail.split("@")[1]?.toLowerCase();
    if (domain) {
      const known = await prisma.institutionDomain.findUnique({ where: { domain } });
      if (known) return VerificationStatus.VERIFIED;
    }
    return VerificationStatus.EMAIL_PENDING;
  }
  if (method === VerificationMethod.STUDENT_ID_CARD || method === VerificationMethod.ENROLLMENT_DOCUMENT) {
    return VerificationStatus.DOCUMENT_PENDING;
  }
  return VerificationStatus.UNDER_REVIEW;
}
