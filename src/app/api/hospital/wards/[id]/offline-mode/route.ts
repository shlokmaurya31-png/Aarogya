import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { setWardOfflineMode } from "@/lib/hospital/offline/switch";

/** POST { enabled, reason }: the hospital admin turns the ward's offline mode on (only with the clinical sign-off) or off (Flagship 4e). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => ({}));
    const { session, facilityId } = await requireFacilityStaff("nursing:offline:manage", body?.facilityId);
    return setWardOfflineMode({ userId: session.userId, facilityId }, (await params).id, body);
  });
}
