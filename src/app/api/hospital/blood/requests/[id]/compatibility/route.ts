import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { recordCompatibility } from "@/lib/hospital/blood";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("blood:compatibility:record", body?.facilityId);
    if (!staff) throw new BadRequestError("Compatibility testing must be recorded by a lab account.");
    const test = await recordCompatibility({
      requestId: id, facilityId, unitId: body?.unitId, testType: body?.testType, aboResult: body?.aboResult, rhResult: body?.rhResult,
      antibodyScreen: body?.antibodyScreen, crossmatchResult: body?.crossmatchResult, status: body?.status, testedByStaffId: staff.id, notes: body?.notes, byUserId: session.userId,
    });
    return { test };
  });
}
