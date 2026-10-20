import { requireSession, withApiErrors, ForbiddenError } from "@/lib/auth/rbac";
import { listOwnShares } from "@/lib/sharing/shares";

/** Week 4c: your shares — live ones, and those that ended in the last 30 days. */
export async function GET() {
  return withApiErrors(async () => {
    const session = await requireSession();
    if (session.role !== "PATIENT") throw new ForbiddenError("patient:self:manage");
    return { shares: await listOwnShares(session.userId) };
  });
}
