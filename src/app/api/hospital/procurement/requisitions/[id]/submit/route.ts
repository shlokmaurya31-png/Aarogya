import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { submitRequisition } from "@/lib/hospital/procurement/requisitions";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("procurement:requisition:create", body?.facilityId);

    const requisition = await prisma.purchaseRequisition.findUnique({ where: { id } });
    if (!requisition || requisition.facilityId !== facilityId) throw new NotFoundError("Requisition not found.");

    const updated = await prisma.$transaction((tx) => submitRequisition(tx, id));
    await recordAuditEvent("hospital.procurement.requisitionSubmitted", session.userId, { requisitionId: id, requisitionNumber: updated.requisitionNumber }, { facilityId });
    return { requisition: updated };
  });
}
