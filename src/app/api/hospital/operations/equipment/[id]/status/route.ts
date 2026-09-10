import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { setEquipmentStatus } from "@/lib/hospital/operations/service";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("biomedical:manage", body?.facilityId);
    if (!body?.to) throw new BadRequestError("to (target status) is required.");
    return { equipment: await setEquipmentStatus({ equipmentId: id, facilityId, to: body.to, byUserId: session.userId }) };
  });
}
