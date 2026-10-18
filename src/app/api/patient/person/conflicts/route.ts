import { requireSession, withApiErrors, ForbiddenError } from "@/lib/auth/rbac";
import { listOwnConflicts } from "@/lib/documents/conflicts";

/** Week 4a: where your uploaded reports disagree with a hospital's verified record — the verified value first. */
export async function GET() {
  return withApiErrors(async () => {
    const session = await requireSession();
    if (session.role !== "PATIENT") throw new ForbiddenError("patient:self:manage");
    return listOwnConflicts(session.userId);
  });
}
