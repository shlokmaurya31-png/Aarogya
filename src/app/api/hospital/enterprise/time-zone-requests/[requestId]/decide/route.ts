import { NextRequest } from "next/server";
import { ForbiddenError, withApiErrors } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { decideTimeZoneChange } from "@/lib/hospital/facilityTimeZoneChange";

/**
 * POST { decision: APPROVE | REJECT, note, confirmFutureAppointments? }:
 * platform staff decide a facility's time-zone change. Approval with future
 * bookings is a 409 unless confirmed; then each booking is notified.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ requestId: string }> }) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("platform:facility:time-zone");
    if (!m.isPlatformAdmin) throw new ForbiddenError("platform:facility:time-zone");
    return decideTimeZoneChange({ userId: m.userId }, (await params).requestId, await req.json().catch(() => ({})));
  });
}
