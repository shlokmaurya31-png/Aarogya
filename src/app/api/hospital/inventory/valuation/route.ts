import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { getInventoryValuation } from "@/lib/hospital/inventory/inventoryAdvanced";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("inventory:valuation:view", searchParams.get("facilityId") ?? undefined);
    return { valuation: await getInventoryValuation(facilityId, { locationId: searchParams.get("locationId") ?? undefined, category: searchParams.get("category") ?? undefined }) };
  });
}
