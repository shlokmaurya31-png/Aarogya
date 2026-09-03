import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("lab:result:acknowledge", body?.facilityId);

    const order = await prisma.labOrder.findUnique({ where: { id }, include: { encounter: true, results: { where: { isCurrent: true } } } });
    const currentResult = order?.results[0];
    if (!order || order.encounter.facilityId !== facilityId || !currentResult) throw new NotFoundError("Lab result not found.");

    const updated = await prisma.labResult.update({
      where: { id: currentResult.id },
      data: { acknowledgedByStaffId: session.userId, acknowledgedAt: new Date() },
    });

    await recordAuditEvent("hospital.lab.criticalResultAcknowledged", session.userId, { labOrderId: id });
    return { result: updated };
  });
}
