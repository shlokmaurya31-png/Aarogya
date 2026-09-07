import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { approveAdjustment } from "@/lib/hospital/inventory/adjustment";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("inventory:stock:adjust", body?.facilityId);
    if (!staff) throw new NotFoundError("Approving staff not found.");

    const adjustment = await prisma.stockAdjustment.findUnique({ where: { id } });
    if (!adjustment || adjustment.facilityId !== facilityId) throw new NotFoundError("Adjustment not found.");

    const updated = await prisma.$transaction((tx) => approveAdjustment(tx, id, { approvedByStaffId: staff.id, actorUserId: session.userId }));
    await recordAuditEvent("hospital.inventory.adjustmentApproved", session.userId, { adjustmentId: id }, { facilityId });
    return { adjustment: updated };
  });
}
