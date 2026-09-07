import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { recordGoodsReceipt, assignGoodsReceiptNumber } from "@/lib/hospital/procurement/goodsReceipts";
import { clampPageSize } from "@/lib/hospital/inventory/expiry";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("procurement:goodsReceipt:create", searchParams.get("facilityId") ?? undefined);
    const cursor = searchParams.get("cursor") ?? undefined;
    const goodsReceipts = await prisma.goodsReceipt.findMany({
      where: { facilityId, ...(searchParams.get("status") ? { status: searchParams.get("status") as never } : {}) },
      orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
      take: clampPageSize(searchParams.get("take") ? Number(searchParams.get("take")) : undefined),
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      include: { lines: true },
    });
    return { goodsReceipts };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("procurement:goodsReceipt:create", body?.facilityId);
    if (!staff) throw new BadRequestError("Recording a goods receipt must be performed by a staff account.");

    const { purchaseOrderId, lines } = body ?? {};
    if (!purchaseOrderId) throw new BadRequestError("purchaseOrderId is required.");
    if (!Array.isArray(lines) || lines.length === 0) throw new BadRequestError("At least one line is required.");

    const po = await prisma.purchaseOrder.findUnique({ where: { id: purchaseOrderId } });
    if (!po || po.facilityId !== facilityId) throw new NotFoundError("Purchase order not found.");

    const { receipt, alreadyExisted } = await prisma.$transaction(async (tx) => {
      const result = await recordGoodsReceipt(tx, {
        facilityId,
        purchaseOrderId,
        recordedByStaffId: staff.id,
        lines,
        notes: body?.notes,
        idempotencyKey: body?.idempotencyKey ?? randomUUID(),
      });
      if (!result.alreadyExisted) await assignGoodsReceiptNumber(tx, result.receipt.id, facilityId);
      return result;
    });
    if (!alreadyExisted) {
      await recordAuditEvent("hospital.procurement.goodsReceiptRecorded", session.userId, { goodsReceiptId: receipt.id, purchaseOrderId }, { facilityId });
    }
    return { receipt, alreadyExisted };
  });
}
