import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { prisma } from "@/lib/db";
import { addStockTakeLine } from "@/lib/hospital/inventory/stocktake";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { facilityId } = await requireFacilityStaff("inventory:stocktake:manage", body?.facilityId);

    const stockTake = await prisma.stockTake.findUnique({ where: { id } });
    if (!stockTake || stockTake.facilityId !== facilityId) throw new NotFoundError("Stocktake not found.");
    if (!body?.itemId || !body?.lotId) throw new BadRequestError("itemId and lotId are required.");

    const line = await prisma.$transaction((tx) => addStockTakeLine(tx, id, { itemId: body.itemId, lotId: body.lotId, countedQuantity: body.countedQuantity }));
    return { line };
  });
}
