import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { registerWardDevice } from "@/lib/hospital/offline/service";

/** POST { wardId, label }: register a shared ward tablet for offline nursing (Flagship 2, step 5). */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => ({}));
    const { session, facilityId } = await requireFacilityStaff("nursing:offline:manage", body?.facilityId);
    const d = await registerWardDevice({ userId: session.userId, facilityId }, body);
    return { device: { id: d.id, wardId: d.wardId, label: d.label, status: d.status } };
  });
}
