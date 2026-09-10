import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { transitionSerial } from "@/lib/hospital/inventory/inventoryAdvanced";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("inventory:serial:manage", body?.facilityId);
    if (!body?.to) throw new BadRequestError("to (target status) is required.");
    const serial = await transitionSerial({ serialId: id, facilityId, to: body.to, currentLocationId: body.currentLocationId, byUserId: session.userId });
    return { serial };
  });
}
