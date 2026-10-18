import { NextRequest } from "next/server";
import { requireSession, withApiErrors, ForbiddenError } from "@/lib/auth/rbac";
import { bulkReview } from "@/lib/documents/review";

/** Week 4a: several decisions at once, all or nothing. Confirm only HIGH printed facts. Body { decisions: [{ factId, version, decision }] }. */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const session = await requireSession();
    if (session.role !== "PATIENT") throw new ForbiddenError("patient:self:manage");
    const b = await req.json().catch(() => null);
    return bulkReview(session.userId, { decisions: b?.decisions });
  });
}
