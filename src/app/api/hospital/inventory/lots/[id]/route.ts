import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { prisma } from "@/lib/db";
import { computeAvailable } from "@/lib/hospital/inventory/stockBalance";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("inventory:item:view", searchParams.get("facilityId") ?? undefined);

    const lot = await prisma.itemLot.findUnique({ where: { id }, include: { item: true } });
    if (!lot || lot.facilityId !== facilityId) throw new NotFoundError("Lot not found.");

    const balances = await prisma.stockBalance.findMany({ where: { lotId: id }, include: { location: true } });
    const movements = await prisma.stockLedgerEntry.findMany({ where: { lotId: id }, orderBy: { postedAt: "desc" }, take: 50 });

    return { lot, balances: balances.map((b) => ({ ...b, available: computeAvailable(b) })), movements };
  });
}
