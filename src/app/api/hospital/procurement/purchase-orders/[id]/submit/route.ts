import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { submitForApproval } from "@/lib/hospital/procurement/purchaseOrders";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("procurement:po:create", body?.facilityId);

    const po = await prisma.purchaseOrder.findUnique({ where: { id } });
    if (!po || po.facilityId !== facilityId) throw new NotFoundError("Purchase order not found.");

    const updated = await prisma.$transaction((tx) => submitForApproval(tx, id));
    await recordAuditEvent("hospital.procurement.poSubmitted", session.userId, { purchaseOrderId: id, orderNumber: updated.orderNumber }, { facilityId });
    return { purchaseOrder: updated };
  });
}
