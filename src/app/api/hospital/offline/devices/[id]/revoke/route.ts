import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { revokeWardDevice } from "@/lib/hospital/offline/service";

/** POST: revoke a ward device; its dose leases end (Flagship 2, step 5). Another facility's device is a 404. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => ({}));
    const { session, facilityId } = await requireFacilityStaff("nursing:offline:manage", body?.facilityId);
    const d = await revokeWardDevice({ userId: session.userId, facilityId }, (await params).id);
    return { device: { id: d.id, status: d.status } };
  });
}
