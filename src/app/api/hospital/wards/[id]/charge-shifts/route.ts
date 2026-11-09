import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { assignChargeShift, listChargeShifts } from "@/lib/hospital/offline/chargeShift";

/** GET: the ward's charge-nurse roster (shifts not yet ended). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { facilityId } = await requireFacilityStaff("nursing:offline:manage", req.nextUrl.searchParams.get("facilityId") ?? undefined);
    return { shifts: await listChargeShifts(facilityId, (await params).id) };
  });
}

/** POST { staffId, startAt, endAt }: the charge nurse for one shift on the ward (Flagship 3a). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => ({}));
    const { session, facilityId } = await requireFacilityStaff("nursing:offline:manage", body?.facilityId);
    return assignChargeShift({ userId: session.userId, facilityId }, (await params).id, body);
  });
}
