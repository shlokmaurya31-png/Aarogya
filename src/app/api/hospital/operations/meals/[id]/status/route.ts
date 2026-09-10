import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { transitionMeal } from "@/lib/hospital/operations/service";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("dietary:meal:manage", body?.facilityId);
    if (!staff) throw new BadRequestError("Meal workflow requires a staff account.");
    if (!body?.to) throw new BadRequestError("to (target status) is required.");
    return { meal: await transitionMeal({ mealId: id, facilityId, to: body.to, actorStaffId: staff.id, byUserId: session.userId }) };
  });
}
