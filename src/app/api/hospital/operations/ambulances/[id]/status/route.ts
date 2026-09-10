import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { setAmbulanceStatus } from "@/lib/hospital/operations/service";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("ambulance:manage", body?.facilityId);
    if (!["AVAILABLE", "MAINTENANCE", "OUT_OF_SERVICE"].includes(body?.to)) throw new BadRequestError("Invalid target status.");
    return { ambulance: await setAmbulanceStatus({ ambulanceId: id, facilityId, to: body.to, byUserId: session.userId }) };
  });
}
