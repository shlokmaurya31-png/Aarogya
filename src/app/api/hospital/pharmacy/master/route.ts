import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { updateMedicationMaster } from "@/lib/hospital/pharmacy";

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("pharmacy:master:manage", body?.facilityId);
    if (!body?.itemId || !body?.fields) throw new BadRequestError("itemId and fields are required.");
    const item = await updateMedicationMaster({ itemId: body.itemId, facilityId, fields: body.fields, byUserId: session.userId });
    return { item };
  });
}
