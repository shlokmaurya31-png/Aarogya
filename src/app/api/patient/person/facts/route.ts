import { NextRequest } from "next/server";
import { requireSession, withApiErrors, ForbiddenError, BadRequestError } from "@/lib/auth/rbac";
import { factsPage } from "@/lib/documents/review";

const STATUSES = ["PENDING", "CONFIRMED", "CORRECTED", "REJECTED"] as const;

/**
 * Week 4a: your extracted facts (default PENDING), LOW confidence first.
 * ?status=&processingId=&cursor= — Flagship 3c: in pages ({ facts, nextCursor };
 * the first page also { total, byBand }).
 */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const session = await requireSession();
    if (session.role !== "PATIENT") throw new ForbiddenError("patient:self:manage");
    const q = req.nextUrl.searchParams;
    const status = q.get("status") ?? "PENDING";
    if (!(STATUSES as readonly string[]).includes(status)) throw new BadRequestError(`status must be one of ${STATUSES.join(", ")}.`);
    return factsPage(session.userId, undefined, { status: status as (typeof STATUSES)[number], processingId: q.get("processingId") ?? undefined, cursor: q.get("cursor") });
  });
}
