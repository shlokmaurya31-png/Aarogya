import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { verifyCompatibility } from "@/lib/hospital/blood";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("blood:compatibility:verify", body?.facilityId);
    if (!staff) throw new BadRequestError("Verification requires a staff account.");
    const test = await verifyCompatibility({ testId: id, facilityId, verifiedByStaffId: staff.id, byUserId: session.userId });
    return { test };
  });
}
