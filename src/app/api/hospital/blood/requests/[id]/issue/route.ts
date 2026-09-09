import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { issueUnit } from "@/lib/hospital/blood";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("blood:issue", body?.facilityId);
    if (!staff) throw new BadRequestError("Issuing requires a staff account.");
    if (!body?.unitId) throw new BadRequestError("unitId is required.");
    const issue = await issueUnit({ requestId: id, facilityId, unitId: body.unitId, compatibilityTestId: body.compatibilityTestId, issuedByStaffId: staff.id, issueLocation: body.issueLocation, recipientLocation: body.recipientLocation, byUserId: session.userId });
    return { issue };
  });
}
