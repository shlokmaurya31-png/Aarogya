import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { rejectRequisition } from "@/lib/hospital/procurement/requisitions";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("procurement:requisition:approve", body?.facilityId);
    if (!staff) throw new NotFoundError("Rejecting staff not found.");
    if (!body?.reason) throw new BadRequestError("reason is required.");

    const requisition = await prisma.purchaseRequisition.findUnique({ where: { id } });
    if (!requisition || requisition.facilityId !== facilityId) throw new NotFoundError("Requisition not found.");

    const updated = await prisma.$transaction((tx) => rejectRequisition(tx, id, { rejectedByStaffId: staff.id, reason: body.reason }));
    await recordAuditEvent("hospital.procurement.requisitionRejected", session.userId, { requisitionId: id, reason: body.reason }, { facilityId });
    return { requisition: updated };
  });
}
