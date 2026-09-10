import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { transitionIncident } from "@/lib/hospital/quality/service";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    if (!body?.to) throw new BadRequestError("to (target status) is required.");
    // Closing an incident requires the dedicated close permission; every other
    // transition requires the investigate permission.
    const permission = body.to === "CLOSED" ? "quality:incident:close" : "quality:incident:investigate";
    const { session, facilityId, staff } = await requireFacilityStaff(permission, body?.facilityId);
    if (!staff) throw new BadRequestError("This action requires a staff account.");
    const incident = await transitionIncident({ incidentId: id, facilityId, to: body.to, actorStaffId: staff.id, reason: body.reason, assignedInvestigatorStaffId: body.assignedInvestigatorStaffId, byUserId: session.userId });
    return { incident };
  });
}
