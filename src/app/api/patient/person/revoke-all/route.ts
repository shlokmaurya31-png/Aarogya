import { NextRequest } from "next/server";
import { requireSession, withApiErrors, ForbiddenError } from "@/lib/auth/rbac";
import { revokeAllAccess, revokeAllPreview } from "@/lib/sharing/revokeAll";

/** 4c answer: what revoke-all will end, and the paper consents it leaves (with how to withdraw each). */
export async function GET() {
  return withApiErrors(async () => {
    const session = await requireSession();
    if (session.role !== "PATIENT") throw new ForbiddenError("patient:self:manage");
    return revokeAllPreview(session.userId);
  });
}

/** Week 4c: body { confirm: "REVOKE" } — end every share, request and consent you gave (the treating hospital keeps its own record). */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const session = await requireSession();
    if (session.role !== "PATIENT") throw new ForbiddenError("patient:self:manage");
    const b = await req.json().catch(() => null);
    return revokeAllAccess(session.userId, b?.confirm);
  });
}
