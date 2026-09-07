import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { prisma } from "@/lib/db";
import { computeAvailable } from "@/lib/hospital/inventory/stockBalance";
import { clampPageSize } from "@/lib/hospital/inventory/expiry";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("inventory:stock:view", searchParams.get("facilityId") ?? undefined);
    const cursor = searchParams.get("cursor") ?? undefined;

    const balances = await prisma.stockBalance.findMany({
      where: { facilityId, ...(searchParams.get("itemId") ? { itemId: searchParams.get("itemId")! } : {}), ...(searchParams.get("locationId") ? { locationId: searchParams.get("locationId")! } : {}) },
      orderBy: [{ id: "asc" }],
      take: clampPageSize(searchParams.get("take") ? Number(searchParams.get("take")) : undefined),
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      include: { item: true, lot: true, location: true },
    });
    return { balances: balances.map((b) => ({ ...b, available: computeAvailable(b) })) };
  });
}
