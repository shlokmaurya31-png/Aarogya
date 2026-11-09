import { ForbiddenError, withApiErrors } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { listOpenTimeZoneChanges } from "@/lib/hospital/facilityTimeZoneChange";

/** GET: every facility's open time-zone change requests, with each facility's future bookings now (platform staff only). */
export async function GET() {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("platform:facility:time-zone");
    if (!m.isPlatformAdmin) throw new ForbiddenError("platform:facility:time-zone");
    return { requests: await listOpenTimeZoneChanges() };
  });
}
