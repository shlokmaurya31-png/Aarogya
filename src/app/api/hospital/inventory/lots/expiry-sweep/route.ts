import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { prisma } from "@/lib/db";

/** Admin-triggered manual sweep — no cron exists anywhere in this codebase, so expiry state for lots nobody has recently touched (issueStock's lazy per-lot flip only fires on read) is corrected here instead, keeping the Expiring-Soon/Expired dashboards accurate. */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { facilityId } = await requireFacilityStaff("inventory:item:manage", body?.facilityId);

    const result = await prisma.itemLot.updateMany({
      where: { facilityId, status: "ACTIVE", expiresAt: { lte: new Date() } },
      data: { status: "EXPIRED" },
    });
    return { sweptCount: result.count };
  });
}
