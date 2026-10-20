import { NextRequest } from "next/server";
import { requireSession, withApiErrors, ForbiddenError } from "@/lib/auth/rbac";
import { decideRequest } from "@/lib/sharing/requests";

/**
 * Week 4c: body { decision: "APPROVE" | "DECLINE", categories?, sensitiveCategories?, period?, validDays? }.
 * Approve as asked or narrower; sensitive categories only if you add them.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const session = await requireSession();
    if (session.role !== "PATIENT") throw new ForbiddenError("patient:self:manage");
    return decideRequest(session.userId, id, await req.json().catch(() => null));
  });
}
