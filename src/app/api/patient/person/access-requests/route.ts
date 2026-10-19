import { requireSession, withApiErrors, ForbiddenError } from "@/lib/auth/rbac";
import { listOwnRequests } from "@/lib/sharing/requests";

/** Week 4c: requests to see your record — waiting ones first. */
export async function GET() {
  return withApiErrors(async () => {
    const session = await requireSession();
    if (session.role !== "PATIENT") throw new ForbiddenError("patient:self:manage");
    return { requests: await listOwnRequests(session.userId) };
  });
}
