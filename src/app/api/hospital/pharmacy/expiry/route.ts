import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { getExpiryReport } from "@/lib/hospital/pharmacy";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("inventory:stock:view", searchParams.get("facilityId") ?? undefined);
    const windowDays = searchParams.get("windowDays") ? Number(searchParams.get("windowDays")) : undefined;
    return { report: await getExpiryReport(facilityId, { windowDays }) };
  });
}
