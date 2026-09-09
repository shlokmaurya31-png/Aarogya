import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { closeRecall } from "@/lib/hospital/pharmacy";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("pharmacy:recall", body?.facilityId);
    if (!staff) throw new BadRequestError("Recall management requires a staff account.");
    return { recall: await closeRecall({ recallId: id, facilityId, closedByStaffId: staff.id, byUserId: session.userId }) };
  });
}
