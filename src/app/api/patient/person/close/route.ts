import { NextRequest } from "next/server";
import { requireSession, withApiErrors, ForbiddenError } from "@/lib/auth/rbac";
import { closePersonAccount } from "@/lib/person/closure";

/** Phase 0: close your account. Body { confirm: "CLOSE" }. Your data is deleted after 30 days unless you reopen it. */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const session = await requireSession();
    if (session.role !== "PATIENT") throw new ForbiddenError("patient:self:manage");
    const b = await req.json().catch(() => null);
    return closePersonAccount(session.userId, String(b?.confirm ?? ""));
  });
}
