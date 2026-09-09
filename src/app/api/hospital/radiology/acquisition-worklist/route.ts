import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { getRadiologyAcquisitionWorklist } from "@/lib/hospital/diagnosticsAdvanced";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("radiology:study:execute", searchParams.get("facilityId") ?? undefined);
    return { worklist: await getRadiologyAcquisitionWorklist(facilityId) };
  });
}
