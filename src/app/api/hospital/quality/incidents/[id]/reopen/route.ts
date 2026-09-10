import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { reopenIncident } from "@/lib/hospital/quality/service";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("quality:incident:close", body?.facilityId);
    if (!staff) throw new BadRequestError("This action requires a staff account.");
    if (!body?.reason) throw new BadRequestError("A reason is required to reopen an incident.");
    const incident = await reopenIncident({ incidentId: id, facilityId, actorStaffId: staff.id, reason: body.reason, byUserId: session.userId });
    return { incident };
  });
}
