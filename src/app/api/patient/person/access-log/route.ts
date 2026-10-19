import { NextRequest } from "next/server";
import { requireSession, withApiErrors, ForbiddenError } from "@/lib/auth/rbac";
import { listOwnAccessLog } from "@/lib/sharing/accessLog";

/** Week 4c: who opened your record, when, and by which way in. ?before=<ISO>&limit= */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const session = await requireSession();
    if (session.role !== "PATIENT") throw new ForbiddenError("patient:self:manage");
    const q = req.nextUrl.searchParams;
    return listOwnAccessLog(session.userId, { before: q.get("before") ?? undefined, limit: q.get("limit") ? Number(q.get("limit")) : undefined });
  });
}
