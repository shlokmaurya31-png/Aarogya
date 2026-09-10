import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { createInfectionInvestigation } from "@/lib/hospital/operations/service";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("infection:manage", body?.facilityId);
    if (!staff) throw new BadRequestError("Requires a staff account.");
    return { investigation: await createInfectionInvestigation({ incidentId: id, facilityId, investigatorStaffId: staff.id, findings: body?.findings, actionTaken: body?.actionTaken, byUserId: session.userId }) };
  });
}
