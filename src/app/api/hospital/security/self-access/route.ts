import { NextRequest } from "next/server";
import { BadRequestError, withApiErrors } from "@/lib/auth/rbac";
import { buildAuthorizationActor } from "@/lib/auth/authorize/context";
import { requireAuthorization } from "@/lib/auth/authorize/engine";
import { selfAccessReport } from "@/lib/doctors/self";

/** GET ?days= — the facility's self-access report: staff who read their own chart (5b follow-up). Admins only. */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const actor = await buildAuthorizationActor(searchParams.get("facilityId") ?? undefined);
    await requireAuthorization({ actor, action: "selfaccess.review", resource: { type: "SECURITY", facilityId: actor.facilityId } });
    if (!actor.facilityId) throw new BadRequestError("A facility is required.");
    return selfAccessReport(actor.facilityId, Number(searchParams.get("days") ?? 30) || 30);
  });
}
