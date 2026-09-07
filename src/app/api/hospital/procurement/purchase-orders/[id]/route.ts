import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { prisma } from "@/lib/db";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("procurement:po:view", searchParams.get("facilityId") ?? undefined);
    const purchaseOrder = await prisma.purchaseOrder.findUnique({ where: { id }, include: { lines: true, supplier: true, goodsReceipts: { include: { lines: true } } } });
    if (!purchaseOrder || purchaseOrder.facilityId !== facilityId) throw new NotFoundError("Purchase order not found.");
    return { purchaseOrder };
  });
}
