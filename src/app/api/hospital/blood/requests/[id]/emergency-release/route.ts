import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { authorizeEmergencyRelease } from "@/lib/hospital/blood";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("blood:request:review", body?.facilityId);
    if (!staff) throw new BadRequestError("Emergency release must be authorized by a clinician account.");
    if (!body?.reason) throw new BadRequestError("reason is required.");
    const request = await authorizeEmergencyRelease({ requestId: id, facilityId, reason: body.reason, authorizedByStaffId: staff.id, byUserId: session.userId });
    return { request };
  });
}
