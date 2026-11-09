import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { cancelChargeShift } from "@/lib/hospital/offline/chargeShift";

/** POST: cancel a rostered charge-nurse shift (the ward's named charge nurse then covers it). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ shiftId: string }> }) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => ({}));
    const { session, facilityId } = await requireFacilityStaff("nursing:offline:manage", body?.facilityId);
    return cancelChargeShift({ userId: session.userId, facilityId }, (await params).shiftId);
  });
}
