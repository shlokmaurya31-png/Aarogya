import { requireSession, withApiErrors, ForbiddenError } from "@/lib/auth/rbac";
import { personOverview } from "@/lib/person/overview";

/** Phase 0: the caller's own Person — links, sharing choice, access log. Owner only. */
export async function GET() {
  return withApiErrors(async () => {
    const session = await requireSession();
    if (session.role !== "PATIENT") throw new ForbiddenError("patient:self:read");
    return personOverview(session.userId);
  });
}
