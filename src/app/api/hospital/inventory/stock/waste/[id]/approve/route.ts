import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { approveWaste } from "@/lib/hospital/inventory/waste";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("inventory:stock:waste", body?.facilityId);
    if (!staff) throw new NotFoundError("Approving staff not found.");

    const waste = await prisma.wasteRecord.findUnique({ where: { id } });
    if (!waste || waste.facilityId !== facilityId) throw new NotFoundError("Waste record not found.");

    const updated = await prisma.$transaction((tx) => approveWaste(tx, id, { approvedByStaffId: staff.id, actorUserId: session.userId }));
    await recordAuditEvent("hospital.inventory.wasteApproved", session.userId, { wasteId: id }, { facilityId });
    return { waste: updated };
  });
}
