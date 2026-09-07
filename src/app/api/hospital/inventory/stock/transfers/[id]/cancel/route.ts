import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { cancelTransfer } from "@/lib/hospital/inventory/transfer";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("inventory:stock:transfer", body?.facilityId);

    const transfer = await prisma.stockTransfer.findUnique({ where: { id } });
    if (!transfer || transfer.facilityId !== facilityId) throw new NotFoundError("Transfer not found.");
    if (!body?.reason) throw new BadRequestError("reason is required.");

    const updated = await prisma.$transaction((tx) => cancelTransfer(tx, id, { reason: body.reason, actorUserId: session.userId }));
    await recordAuditEvent("hospital.inventory.transferCancelled", session.userId, { transferId: id, reason: body.reason }, { facilityId });
    return { transfer: updated };
  });
}
