import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { listImagingResources } from "@/lib/hospital/imagingCatalog";

/** Bookable modality/room resources (brief §8) — facility-scoped. */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);
    const resources = await listImagingResources(facilityId);
    return { resources };
  });
}
