import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { prisma } from "@/lib/db";
import { clampPageSize } from "@/lib/hospital/inventory/expiry";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("inventory:item:view", searchParams.get("facilityId") ?? undefined);
    const itemId = searchParams.get("itemId") ?? undefined;
    const status = (searchParams.get("status") as never) ?? undefined;
    const cursor = searchParams.get("cursor") ?? undefined;

    const lots = await prisma.itemLot.findMany({
      where: { facilityId, itemId, status },
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
      take: clampPageSize(searchParams.get("take") ? Number(searchParams.get("take")) : undefined),
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      include: { item: true },
    });
    return { lots };
  });
}
