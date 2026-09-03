import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { listImagingCatalog } from "@/lib/hospital/imagingCatalog";

/** Imaging catalog (brief §4) — facility-scoped entries plus global (facilityId=null) entries. */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);
    const studies = await listImagingCatalog(facilityId);
    return { studies };
  });
}
