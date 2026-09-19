import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { getCommandCenterOverview } from "@/lib/hospital-os/command-center";
import { BASE_PERMISSION } from "@/lib/hospital-os/command-center";

/** GET: the full Command Center 2.0 overview (authorized sections only, tenant-scoped). */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const sp = new URL(req.url).searchParams;
    const fctx = await requireFacilityStaff(BASE_PERMISSION, sp.get("facilityId") ?? undefined);
    return getCommandCenterOverview(fctx, {
      window: sp.get("window"),
      from: sp.get("from"),
      to: sp.get("to"),
      departmentId: sp.get("departmentId"),
    });
  });
}
