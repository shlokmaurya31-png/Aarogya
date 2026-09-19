import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { getDrillDown, BASE_PERMISSION } from "@/lib/hospital-os/command-center";

/** GET: a bounded, authorized Command Center drill-down (tenant-scoped, privacy-aware). */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const sp = new URL(req.url).searchParams;
    const kind = sp.get("kind");
    if (!kind) throw new BadRequestError("kind is required.");
    const fctx = await requireFacilityStaff(BASE_PERMISSION, sp.get("facilityId") ?? undefined);
    const owner = sp.get("owner");
    return getDrillDown(fctx, kind, owner ? { owner } : {});
  });
}
