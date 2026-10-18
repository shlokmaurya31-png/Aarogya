import { requireSession, withApiErrors, ForbiddenError } from "@/lib/auth/rbac";
import { reopenPersonAccount } from "@/lib/person/closure";

/** Phase 0: reopen your closed account within the 30-day grace period. */
export async function POST() {
  return withApiErrors(async () => {
    const session = await requireSession();
    if (session.role !== "PATIENT") throw new ForbiddenError("patient:self:manage");
    return reopenPersonAccount(session.userId);
  });
}
