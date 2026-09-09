import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { recordReassessment } from "@/lib/hospital/emergency";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("ed:reassessment:record", body?.facilityId);
    if (!staff) throw new BadRequestError("Reassessment requires a staff account.");
    const reassessment = await recordReassessment({
      encounterId: id, facilityId, reassessedByStaffId: staff.id, findings: body?.findings, vitalId: body?.vitalId,
      escalationRequired: body?.escalationRequired, taskId: body?.taskId, byUserId: session.userId,
    });
    return { reassessment };
  });
}
