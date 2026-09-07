import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { approvePurchaseOrder } from "@/lib/hospital/procurement/purchaseOrders";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("procurement:po:approve", body?.facilityId);
    if (!staff) throw new NotFoundError("Approving staff not found.");

    const po = await prisma.purchaseOrder.findUnique({ where: { id } });
    if (!po || po.facilityId !== facilityId) throw new NotFoundError("Purchase order not found.");

    const updated = await prisma.$transaction((tx) => approvePurchaseOrder(tx, id, { approvedByStaffId: staff.id }));
    await recordAuditEvent("hospital.procurement.poApproved", session.userId, { purchaseOrderId: id }, { facilityId });
    return { purchaseOrder: updated };
  });
}
