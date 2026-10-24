import { NextRequest } from "next/server";
import { BadRequestError, withApiErrors } from "@/lib/auth/rbac";
import { buildAuthorizationActor } from "@/lib/auth/authorize/context";
import { requireAuthorization } from "@/lib/auth/authorize/engine";
import { getFacilityGateway, setFacilityGateway } from "@/lib/insurance/hospitalPayments";

/** GET — this facility's own payment gateway (no secret is ever returned) (Week 5c). */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const actor = await buildAuthorizationActor(req.nextUrl.searchParams.get("facilityId") ?? undefined);
    await requireAuthorization({ actor, action: "paymentgateway.manage", resource: { type: "SECURITY", facilityId: actor.facilityId } });
    if (!actor.facilityId) throw new BadRequestError("A facility is required.");
    return getFacilityGateway(actor.facilityId);
  });
}

/** PUT { keyId (rzp_test_…), secretRef, mode: "TEST", enabled } — the secrets stay in the environment under secretRef. */
export async function PUT(req: NextRequest) {
  return withApiErrors(async () => {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const actor = await buildAuthorizationActor(typeof body.facilityId === "string" ? body.facilityId : undefined);
    await requireAuthorization({ actor, action: "paymentgateway.manage", resource: { type: "SECURITY", facilityId: actor.facilityId } });
    if (!actor.facilityId) throw new BadRequestError("A facility is required.");
    return setFacilityGateway({ userId: actor.userId, facilityId: actor.facilityId }, body);
  });
}
