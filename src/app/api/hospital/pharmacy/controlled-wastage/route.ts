import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { recordControlledWastage } from "@/lib/hospital/pharmacy";

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("pharmacy:controlled:manage", body?.facilityId);
    if (!staff) throw new BadRequestError("Controlled wastage requires a staff account.");
    if (!body?.itemId || !body?.itemLotId || !body?.locationId || !body?.quantity || !body?.witnessStaffId) {
      throw new BadRequestError("itemId, itemLotId, locationId, quantity, and witnessStaffId are required.");
    }
    const wastage = await recordControlledWastage({
      facilityId, itemId: body.itemId, itemLotId: body.itemLotId, locationId: body.locationId, quantity: Number(body.quantity), reason: body.reason,
      medicationOrderId: body.medicationOrderId, patientId: body.patientId, encounterId: body.encounterId, witnessStaffId: body.witnessStaffId,
      recordedByStaffId: staff.id, wasteReason: body.wasteReason, byUserId: session.userId,
    });
    return { wastage };
  });
}
