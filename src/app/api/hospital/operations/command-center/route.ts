import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { getOperationsCommandCenter } from "@/lib/hospital/operations/commandCenter";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("operations:command:view", searchParams.get("facilityId") ?? undefined);
    return { commandCenter: await getOperationsCommandCenter(facilityId) };
  });
}
