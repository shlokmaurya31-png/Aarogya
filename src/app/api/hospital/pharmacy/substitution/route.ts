import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { recordSubstitution } from "@/lib/hospital/pharmacy";

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("pharmacy:substitution:authorize", body?.facilityId);
    if (!staff) throw new BadRequestError("Substitution requires a staff account.");
    if (!body?.medicationOrderId || !body?.replacementDrugName || !body?.reason) throw new BadRequestError("medicationOrderId, replacementDrugName, and reason are required.");
    const substitution = await recordSubstitution({ medicationOrderId: body.medicationOrderId, facilityId, replacementDrugName: body.replacementDrugName, replacementItemId: body.replacementItemId, reason: body.reason, authorizedByStaffId: staff.id, byUserId: session.userId });
    return { substitution };
  });
}
