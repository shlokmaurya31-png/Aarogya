import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { getCommandCenterSnapshot } from "@/lib/hospital/commandCenter";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("hospital:command-center:view", searchParams.get("facilityId") ?? undefined);
    return getCommandCenterSnapshot(facilityId);
  });
}
