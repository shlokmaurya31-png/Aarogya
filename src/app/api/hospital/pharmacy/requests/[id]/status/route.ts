import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { transitionPharmacyRequest } from "@/lib/hospital/pharmacy";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("pharmacy:request:fulfill", body?.facilityId);
    if (!staff) throw new BadRequestError("Fulfilling a request requires a staff account.");
    if (!body?.to) throw new BadRequestError("to (target status) is required.");
    const request = await transitionPharmacyRequest({ requestId: id, facilityId, to: body.to, actorStaffId: staff.id, fulfillLocationId: body.fulfillLocationId, lotId: body.lotId, byUserId: session.userId });
    return { request };
  });
}
