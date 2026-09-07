import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { prisma } from "@/lib/db";
import { clampPageSize } from "@/lib/hospital/inventory/expiry";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("inventory:stock:view", searchParams.get("facilityId") ?? undefined);
    const cursor = searchParams.get("cursor") ?? undefined;

    const movements = await prisma.stockLedgerEntry.findMany({
      where: {
        facilityId,
        ...(searchParams.get("itemId") ? { itemId: searchParams.get("itemId")! } : {}),
        ...(searchParams.get("movementType") ? { movementType: searchParams.get("movementType") as never } : {}),
      },
      orderBy: [{ postedAt: "desc" }, { id: "desc" }],
      take: clampPageSize(searchParams.get("take") ? Number(searchParams.get("take")) : undefined),
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    return { movements };
  });
}
