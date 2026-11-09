import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { deskQueue } from "@/lib/hospital/scanShare/service";

/** GET ?day=YYYY-MM-DD: the day's Scan and Share check-ins, by token (Flagship 6). */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const q = req.nextUrl.searchParams;
    const { facilityId } = await requireFacilityStaff("queue:manage", q.get("facilityId") ?? undefined);
    return deskQueue(facilityId, q.get("day") ?? undefined);
  });
}
