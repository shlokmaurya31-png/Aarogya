import { requireSession, withApiErrors, ForbiddenError } from "@/lib/auth/rbac";
import { pendingConfirmations } from "@/lib/person/linking";

/** Phase 0: connections waiting for your confirmation (after in-person verification by two staff members). */
export async function GET() {
  return withApiErrors(async () => {
    const session = await requireSession();
    if (session.role !== "PATIENT") throw new ForbiddenError("patient:self:read");
    return { pending: await pendingConfirmations(session.userId) };
  });
}
