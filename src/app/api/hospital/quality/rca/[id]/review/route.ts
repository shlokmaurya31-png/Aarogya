import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { reviewRca } from "@/lib/hospital/quality/service";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("quality:rca:review", body?.facilityId);
    if (!staff) throw new BadRequestError("This action requires a staff account.");
    const rca = await reviewRca({ rcaId: id, facilityId, reviewedByStaffId: staff.id, byUserId: session.userId });
    return { rca };
  });
}
