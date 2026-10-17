import { expireLapsedLots } from "@/lib/hospital/inventory/lots";
import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";

/** Admin-triggered manual sweep — no cron exists anywhere in this codebase, so expiry state for lots nobody has recently touched (issueStock's lazy per-lot flip only fires on read) is corrected here instead, keeping the Expiring-Soon/Expired dashboards accurate. */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("inventory:item:manage", body?.facilityId);

    const { expired } = await expireLapsedLots(facilityId, session.userId);
    return { sweptCount: expired };
  });
}
