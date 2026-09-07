import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { prisma } from "@/lib/db";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("procurement:goodsReceipt:create", searchParams.get("facilityId") ?? undefined);
    const receipt = await prisma.goodsReceipt.findUnique({ where: { id }, include: { lines: true, purchaseOrder: true } });
    if (!receipt || receipt.facilityId !== facilityId) throw new NotFoundError("Goods receipt not found.");
    return { receipt };
  });
}
