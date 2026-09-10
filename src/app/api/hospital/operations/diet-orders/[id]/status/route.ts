import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { setDietOrderStatus, planMeal } from "@/lib/hospital/operations/service";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("dietary:order:manage", body?.facilityId);
    if (body?.action === "planMeal") {
      if (!body?.mealPeriod || !body?.plannedFor) throw new BadRequestError("mealPeriod and plannedFor are required.");
      return { meal: await planMeal({ dietOrderId: id, facilityId, mealPeriod: body.mealPeriod, plannedFor: new Date(body.plannedFor), byUserId: session.userId }) };
    }
    if (body?.to !== "DISCONTINUED" && body?.to !== "CANCELLED") throw new BadRequestError("to must be DISCONTINUED or CANCELLED.");
    return { order: await setDietOrderStatus({ dietOrderId: id, facilityId, to: body.to, byUserId: session.userId }) };
  });
}
