import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { getAdvancedDiagnosticsCounts } from "@/lib/hospital/diagnosticsAdvanced";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("hospital:command-center:view", searchParams.get("facilityId") ?? undefined);
    return { counts: await getAdvancedDiagnosticsCounts(facilityId) };
  });
}
