import { NextRequest } from "next/server";
import { requireSession, withApiErrors, ForbiddenError } from "@/lib/auth/rbac";
import { revokeAllAccess } from "@/lib/sharing/revokeAll";

/** Week 4c: body { confirm: "REVOKE" } — end every share, request and consent you gave (the treating hospital keeps its own record). */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const session = await requireSession();
    if (session.role !== "PATIENT") throw new ForbiddenError("patient:self:manage");
    const b = await req.json().catch(() => null);
    return revokeAllAccess(session.userId, b?.confirm);
  });
}
