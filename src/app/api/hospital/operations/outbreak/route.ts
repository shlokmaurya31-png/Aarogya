import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { getOutbreakWorkspace } from "@/lib/hospital/operations/commandCenter";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("infection:manage", searchParams.get("facilityId") ?? undefined);
    const sinceDays = searchParams.get("sinceDays") ? Number(searchParams.get("sinceDays")) : undefined;
    return { groups: await getOutbreakWorkspace(facilityId, { sinceDays }) };
  });
}
