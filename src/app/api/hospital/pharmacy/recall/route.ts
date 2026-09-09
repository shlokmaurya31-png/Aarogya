import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { createRecall } from "@/lib/hospital/pharmacy";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("inventory:stock:view", searchParams.get("facilityId") ?? undefined);
    const recalls = await prisma.medicationRecall.findMany({ where: { facilityId }, orderBy: { createdAt: "desc" }, take: 100 });
    return { recalls };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("pharmacy:recall", body?.facilityId);
    if (!staff) throw new BadRequestError("Recall management requires a staff account.");
    if (!body?.itemId || !body?.reason) throw new BadRequestError("itemId and reason are required.");
    const recall = await createRecall({ facilityId, itemId: body.itemId, itemLotId: body.itemLotId, manufacturer: body.manufacturer, batchRef: body.batchRef, reason: body.reason, reference: body.reference, createdByStaffId: staff.id, byUserId: session.userId });
    return { recall };
  });
}
