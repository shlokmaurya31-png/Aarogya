import { NextRequest } from "next/server";
import { ForbiddenError, requireSession, withApiErrors } from "@/lib/auth/rbac";
import { caseDocumentUrl } from "@/lib/doctors/verification";

/** GET — a 5-minute URL for one of the doctor's own case documents (Week 5a). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ caseId: string; index: string }> }) {
  return withApiErrors(async () => {
    const s = await requireSession();
    if (s.role !== "DOCTOR") throw new ForbiddenError("doctor:profile:manage");
    const { caseId, index } = await params;
    return caseDocumentUrl({ userId: s.userId, verifier: false }, caseId, Number(index));
  });
}
