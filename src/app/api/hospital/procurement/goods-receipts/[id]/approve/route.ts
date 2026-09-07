import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { approveGoodsReceipt } from "@/lib/hospital/procurement/goodsReceipts";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("procurement:goodsReceipt:approve", body?.facilityId);
    if (!staff) throw new NotFoundError("Approving staff not found.");

    const receipt = await prisma.goodsReceipt.findUnique({ where: { id } });
    if (!receipt || receipt.facilityId !== facilityId) throw new NotFoundError("Goods receipt not found.");

    const updated = await prisma.$transaction((tx) => approveGoodsReceipt(tx, id, { approvedByStaffId: staff.id, actorUserId: session.userId }));
    await recordAuditEvent("hospital.procurement.goodsReceiptApproved", session.userId, { goodsReceiptId: id }, { facilityId });
    return { receipt: updated };
  });
}
