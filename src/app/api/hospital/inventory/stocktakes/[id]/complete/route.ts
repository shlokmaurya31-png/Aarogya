import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { completeStockTake } from "@/lib/hospital/inventory/stocktake";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("inventory:stocktake:manage", body?.facilityId);
    if (!staff) throw new BadRequestError("Completing a stocktake must be performed by a staff account.");

    const stockTake = await prisma.stockTake.findUnique({ where: { id } });
    if (!stockTake || stockTake.facilityId !== facilityId) throw new NotFoundError("Stocktake not found.");

    const updated = await prisma.$transaction((tx) => completeStockTake(tx, id, { completedByStaffId: staff.id, actorUserId: session.userId }));
    await recordAuditEvent("hospital.inventory.stocktakeCompleted", session.userId, { stockTakeId: id }, { facilityId });
    return { stockTake: updated };
  });
}
