import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { listFacilityTimeZoneChanges, requestTimeZoneChange } from "@/lib/hospital/facilityTimeZoneChange";

/** GET: this facility's time-zone change requests (the hospital admin). */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { facilityId } = await requireFacilityStaff("facility:time-zone:request", req.nextUrl.searchParams.get("facilityId") ?? undefined);
    return { requests: await listFacilityTimeZoneChanges(facilityId) };
  });
}

/** POST { timeZone, writtenRequest }: ask platform staff, in writing, to change the facility's time zone (Flagship 3b). */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => ({}));
    const { session, facilityId } = await requireFacilityStaff("facility:time-zone:request", body?.facilityId);
    return { request: await requestTimeZoneChange({ userId: session.userId, facilityId }, body) };
  });
}
