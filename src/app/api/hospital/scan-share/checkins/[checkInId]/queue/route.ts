import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { queueCheckIn } from "@/lib/hospital/scanShare/service";

/** POST { uhid? }: into the registration queue, for that exact UHID or a record registered from the shared profile (audited). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ checkInId: string }> }) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => ({}));
    const { session, facilityId } = await requireFacilityStaff("queue:manage", body?.facilityId);
    return queueCheckIn({ userId: session.userId, facilityId }, (await params).checkInId, body);
  });
}
