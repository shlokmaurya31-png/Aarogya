import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { createPharmacyTransfer } from "@/lib/hospital/pharmacy";

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("pharmacy:transfer", body?.facilityId);
    if (!staff) throw new BadRequestError("Transfers require a staff account.");
    if (!body?.itemId || !body?.lotId || !body?.fromLocationId || !body?.toLocationId || !body?.quantity) {
      throw new BadRequestError("itemId, lotId, fromLocationId, toLocationId, and quantity are required.");
    }
    const transfer = await createPharmacyTransfer({ facilityId, itemId: body.itemId, lotId: body.lotId, fromLocationId: body.fromLocationId, toLocationId: body.toLocationId, quantity: Number(body.quantity), requestedByStaffId: staff.id, reason: body.reason, byUserId: session.userId });
    return { transfer };
  });
}
