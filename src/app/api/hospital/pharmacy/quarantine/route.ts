import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { quarantinePharmacyLot, releasePharmacyQuarantine } from "@/lib/hospital/pharmacy";

/** action: quarantine | release */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("pharmacy:quarantine", body?.facilityId);
    if (!body?.itemLotId) throw new BadRequestError("itemLotId is required.");
    if (body?.action === "release") {
      return { lot: await releasePharmacyQuarantine({ facilityId, itemLotId: body.itemLotId, byUserId: session.userId }) };
    }
    if (!body?.reason) throw new BadRequestError("reason is required to quarantine.");
    return { lot: await quarantinePharmacyLot({ facilityId, itemLotId: body.itemLotId, reason: body.reason, byUserId: session.userId }) };
  });
}
