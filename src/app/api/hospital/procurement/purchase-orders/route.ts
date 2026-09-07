import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { prisma } from "@/lib/db";
import { createPurchaseOrderDraft, addPurchaseOrderLine } from "@/lib/hospital/procurement/purchaseOrders";
import { clampPageSize } from "@/lib/hospital/inventory/expiry";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("procurement:po:view", searchParams.get("facilityId") ?? undefined);
    const cursor = searchParams.get("cursor") ?? undefined;
    const purchaseOrders = await prisma.purchaseOrder.findMany({
      where: { facilityId, ...(searchParams.get("status") ? { status: searchParams.get("status") as never } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: clampPageSize(searchParams.get("take") ? Number(searchParams.get("take")) : undefined),
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      include: { lines: true, supplier: { select: { name: true } } },
    });
    return { purchaseOrders };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { facilityId, staff } = await requireFacilityStaff("procurement:po:create", body?.facilityId);
    if (!staff) throw new BadRequestError("Creating a purchase order must be performed by a staff account.");

    const { supplierId, lines } = body ?? {};
    if (!supplierId) throw new BadRequestError("supplierId is required.");
    if (!Array.isArray(lines) || lines.length === 0) throw new BadRequestError("At least one line is required.");

    const purchaseOrder = await prisma.$transaction(async (tx) => {
      const draft = await createPurchaseOrderDraft(tx, {
        facilityId,
        supplierId,
        requisitionId: body?.requisitionId,
        expectedDeliveryDate: body?.expectedDeliveryDate ? new Date(body.expectedDeliveryDate) : undefined,
        createdByStaffId: staff.id,
      });
      for (const line of lines) {
        await addPurchaseOrderLine(tx, draft.id, {
          itemId: line.itemId,
          orderedQuantity: line.orderedQuantity,
          unit: line.unit,
          unitPriceMinor: line.unitPriceMinor,
          taxPercent: line.taxPercent,
        });
      }
      return tx.purchaseOrder.findUniqueOrThrow({ where: { id: draft.id }, include: { lines: true } });
    });
    return { purchaseOrder };
  });
}
