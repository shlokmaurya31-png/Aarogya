import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { rejectGoodsReceipt } from "@/lib/hospital/procurement/goodsReceipts";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("procurement:goodsReceipt:approve", body?.facilityId);
    if (!staff) throw new NotFoundError("Rejecting staff not found.");
    if (!body?.reason) throw new BadRequestError("reason is required.");

    const receipt = await prisma.goodsReceipt.findUnique({ where: { id } });
    if (!receipt || receipt.facilityId !== facilityId) throw new NotFoundError("Goods receipt not found.");

    const updated = await prisma.$transaction((tx) => rejectGoodsReceipt(tx, id, { rejectedByStaffId: staff.id, reason: body.reason }));
    await recordAuditEvent("hospital.procurement.goodsReceiptRejected", session.userId, { goodsReceiptId: id, reason: body.reason }, { facilityId });
    return { receipt: updated };
  });
}
