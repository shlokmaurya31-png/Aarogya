import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { chartPreferences, setShowImportedResults } from "@/lib/hospital/chartPreferences";

/** GET: the signed-in staff member's chart preferences (Flagship 4b). */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { session } = await requireFacilityStaff("patient:read", req.nextUrl.searchParams.get("facilityId") ?? undefined);
    return chartPreferences(session.userId);
  });
}

/** PUT { showImportedResults }: imported results in the chart's timeline, for this user only. */
export async function PUT(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => ({}));
    const { session, facilityId } = await requireFacilityStaff("patient:read", body?.facilityId);
    return setShowImportedResults({ userId: session.userId, facilityId }, body);
  });
}
