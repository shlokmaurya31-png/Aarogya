import { NextRequest } from "next/server";
import { requireSession, withApiErrors, BadRequestError, ForbiddenError } from "@/lib/auth/rbac";
import { offerAbhaLink } from "@/lib/person/linking";

/** Phase 0: connect a record whose ABDM-verified ABHA equals yours. Disabled (PERSON_ABHA_LINKING) until ABDM verification exists. */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const session = await requireSession();
    if (session.role !== "PATIENT") throw new ForbiddenError("patient:self:manage");
    const b = await req.json().catch(() => null);
    if (typeof b?.facilityId !== "string") throw new BadRequestError("facilityId is required.");
    return offerAbhaLink(session.userId, b.facilityId);
  });
}
