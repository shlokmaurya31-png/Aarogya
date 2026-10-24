import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { preRegistered } from "@/lib/insurance/checkin";

/** GET ?day=YYYY-MM-DD — patients pre-registered by pre-arrival check-in, with their tokens (Week 5c). */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const q = req.nextUrl.searchParams;
    const { facilityId } = await requireFacilityStaff("queue:manage", q.get("facilityId") ?? undefined);
    return preRegistered(facilityId, q.get("day") ?? undefined);
  });
}
