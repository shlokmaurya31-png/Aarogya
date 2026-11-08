import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { designateChargeNurse } from "@/lib/hospital/offline/service";

/** POST { staffId | null }: name (or clear) the ward's charge nurse (Flagship 2, step 5). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => ({}));
    const { session, facilityId } = await requireFacilityStaff("nursing:offline:manage", body?.facilityId);
    return designateChargeNurse({ userId: session.userId, facilityId }, (await params).id, body);
  });
}
