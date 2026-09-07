import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { releaseLotFromQuarantine } from "@/lib/hospital/inventory/lots";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("inventory:lot:quarantine", body?.facilityId);

    const lot = await prisma.itemLot.findUnique({ where: { id } });
    if (!lot || lot.facilityId !== facilityId) throw new NotFoundError("Lot not found.");

    const updated = await prisma.$transaction((tx) => releaseLotFromQuarantine(tx, id, { byUserId: session.userId }));
    await recordAuditEvent("hospital.inventory.lotReleased", session.userId, { lotId: id }, { facilityId });
    return { lot: updated };
  });
}
