import { NextRequest } from "next/server";
import { requireSession, withApiErrors, ForbiddenError, BadRequestError } from "@/lib/auth/rbac";
import { listOwnFacts } from "@/lib/documents/review";

const STATUSES = ["PENDING", "CONFIRMED", "CORRECTED", "REJECTED"] as const;

/** Week 4a: your extracted facts (default PENDING), LOW confidence first. ?status=&processingId= */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const session = await requireSession();
    if (session.role !== "PATIENT") throw new ForbiddenError("patient:self:manage");
    const status = req.nextUrl.searchParams.get("status") ?? "PENDING";
    if (!(STATUSES as readonly string[]).includes(status)) throw new BadRequestError(`status must be one of ${STATUSES.join(", ")}.`);
    return listOwnFacts(session.userId, { status: status as (typeof STATUSES)[number], processingId: req.nextUrl.searchParams.get("processingId") ?? undefined });
  });
}
