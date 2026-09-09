import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { transitionRequest } from "@/lib/hospital/blood";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("blood:request:review", body?.facilityId);
    if (!staff) throw new BadRequestError("Review actions require a staff account.");
    if (!body?.to) throw new BadRequestError("to (target status) is required.");
    const request = await transitionRequest({ requestId: id, facilityId, to: body.to, actorStaffId: staff.id, reason: body.reason, byUserId: session.userId });
    return { request };
  });
}
