import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { moveEquipment } from "@/lib/hospital/operations/service";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("biomedical:manage", body?.facilityId);
    if (!staff) throw new BadRequestError("Requires a staff account.");
    if (!body?.toLocation) throw new BadRequestError("toLocation is required.");
    return { movement: await moveEquipment({ equipmentId: id, facilityId, toLocation: body.toLocation, reason: body.reason, movedByStaffId: staff.id, byUserId: session.userId }) };
  });
}
