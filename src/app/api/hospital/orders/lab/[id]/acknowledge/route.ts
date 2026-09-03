import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { acknowledgeResult } from "@/lib/hospital/labResultLifecycle";

/**
 * Critical-result acknowledgement — Milestone E hardening (see
 * labResultLifecycle.ts's acknowledgeResult for what changed and why).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("lab:result:acknowledge", body?.facilityId);
    if (!staff) throw new NotFoundError("Staff account required.");

    const order = await prisma.labOrder.findUnique({
      where: { id },
      include: { encounter: true, results: { where: { isCurrent: true, isCritical: true, acknowledgedAt: null } } },
    });
    const currentCriticalResult = order?.results[0];
    if (!order || order.encounter.facilityId !== facilityId || !currentCriticalResult) throw new NotFoundError("No unacknowledged critical lab result found for this order.");

    const updated = await prisma.$transaction((tx) => acknowledgeResult(tx, currentCriticalResult.id, staff.id));

    await recordAuditEvent("hospital.lab.criticalResultAcknowledged", session.userId, { labOrderId: id, resultId: currentCriticalResult.id });
    return { result: updated };
  });
}
