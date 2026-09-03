import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { verifyResult } from "@/lib/hospital/labResultLifecycle";

/** Result verification (brief §19). Guarded concurrent-safe — two techs verifying the same result simultaneously: one wins, one is rejected. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; resultId: string }> }) {
  return withApiErrors(async () => {
    const { id, resultId } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("lab:result:verify", body?.facilityId);
    if (!staff) throw new NotFoundError("Staff account required.");

    const result = await prisma.labResult.findUnique({ where: { id: resultId }, include: { labOrder: { include: { encounter: true } } } });
    if (!result || result.labOrderId !== id || result.labOrder.encounter.facilityId !== facilityId) throw new NotFoundError("Lab result not found.");

    const updated = await prisma.$transaction((tx) => verifyResult(tx, resultId, staff.id));

    await recordAuditEvent("hospital.lab.resultVerified", session.userId, { labOrderId: id, resultId });
    return { result: updated };
  });
}
