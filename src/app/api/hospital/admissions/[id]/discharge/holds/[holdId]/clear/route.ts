import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { clearDischargeHold } from "@/lib/hospital/dischargeHold";

/** Batch 6: clear a manual discharge hold (who and when are recorded). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; holdId: string }> }) {
  return withApiErrors(async () => {
    const { holdId } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("admission:discharge:initiate", body?.facilityId);
    return { hold: await clearDischargeHold({ holdId, facilityId, byUserId: session.userId }) };
  });
}
