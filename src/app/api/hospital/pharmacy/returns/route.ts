import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { createMedicationReturn } from "@/lib/hospital/pharmacy";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("pharmacy:return", searchParams.get("facilityId") ?? undefined);
    const status = searchParams.get("status");
    const returns = await prisma.medicationReturn.findMany({ where: { facilityId, ...(status ? { status: status as never } : {}) }, orderBy: { createdAt: "desc" }, take: 200 });
    return { returns };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("pharmacy:return", body?.facilityId);
    if (!staff) throw new BadRequestError("Returns require a staff account.");
    if (!body?.itemId || !body?.locationId || !body?.quantity || !body?.source) throw new BadRequestError("itemId, locationId, quantity, and source are required.");
    const ret = await createMedicationReturn({
      facilityId, itemId: body.itemId, itemLotId: body.itemLotId, locationId: body.locationId, quantity: Number(body.quantity), unit: body.unit, source: body.source,
      medicationOrderId: body.medicationOrderId, patientId: body.patientId, encounterId: body.encounterId, isControlled: body.isControlled, witnessStaffId: body.witnessStaffId,
      returnedByStaffId: staff.id, reason: body.reason, notes: body.notes, byUserId: session.userId,
    });
    return { return: ret };
  });
}
