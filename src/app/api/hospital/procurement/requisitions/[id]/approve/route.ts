import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { approveRequisition } from "@/lib/hospital/procurement/requisitions";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("procurement:requisition:approve", body?.facilityId);
    if (!staff) throw new NotFoundError("Approving staff not found.");

    const requisition = await prisma.purchaseRequisition.findUnique({ where: { id } });
    if (!requisition || requisition.facilityId !== facilityId) throw new NotFoundError("Requisition not found.");

    const updated = await prisma.$transaction((tx) => approveRequisition(tx, id, { approvedByStaffId: staff.id }));
    await recordAuditEvent("hospital.procurement.requisitionApproved", session.userId, { requisitionId: id }, { facilityId });
    return { requisition: updated };
  });
}
