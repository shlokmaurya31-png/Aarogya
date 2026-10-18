import { NextRequest } from "next/server";
import { requireSession, withApiErrors, ForbiddenError } from "@/lib/auth/rbac";
import { decidePersonConsent, assertDecision } from "@/lib/person/consent";

/**
 * Phase 0: body { decision: "GRANTED" | "DECLINED" } — "share my uploads with
 * hospitals treating me". An affirmative choice (no default); changeable any
 * time. Only the person's own login decides.
 */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const session = await requireSession();
    if (session.role !== "PATIENT") throw new ForbiddenError("patient:self:manage");
    const body = await req.json().catch(() => null);
    return decidePersonConsent({ userId: session.userId, purpose: "SHARE_UPLOADS_WITH_TREATING", decision: assertDecision(body?.decision) });
  });
}
