import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { dispenseFromPharmacy } from "@/lib/hospital/pharmacy";

/** Partial + multi-lot dispense of a medication order from the pharmacy. */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("pharmacy:dispense", body?.facilityId);
    if (!staff) throw new BadRequestError("Dispensing requires a pharmacist staff account.");
    if (!body?.medicationOrderId || !body?.dispensingLocationId || !Array.isArray(body?.allocations) || body.allocations.length === 0) {
      throw new BadRequestError("medicationOrderId, dispensingLocationId, and a non-empty allocations[] are required.");
    }
    const result = await dispenseFromPharmacy({
      medicationOrderId: body.medicationOrderId, facilityId, pharmacistStaffId: staff.id, dispensingLocationId: body.dispensingLocationId,
      allocations: body.allocations, quantityUnit: body.quantityUnit ?? "UNIT", witnessStaffId: body.witnessStaffId,
      substitutedDrugName: body.substitutedDrugName, destination: body.destination, notes: body.notes, byUserId: session.userId,
    });
    return result;
  });
}
