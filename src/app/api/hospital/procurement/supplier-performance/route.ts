import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { getSupplierPerformance } from "@/lib/hospital/procurement/procurementAdvanced";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("procurement:supplier:view", searchParams.get("facilityId") ?? undefined);
    return { performance: await getSupplierPerformance(facilityId) };
  });
}
