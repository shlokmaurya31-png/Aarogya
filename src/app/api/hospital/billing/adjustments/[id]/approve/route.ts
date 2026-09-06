import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { approveAdjustment } from "@/lib/hospital/billing/adjustments";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("billing:adjustment:approve", body?.facilityId);

    const adjustment = await prisma.financialAdjustment.findUnique({ where: { id }, include: { invoice: true } });
    if (!adjustment || adjustment.invoice.facilityId !== facilityId) throw new NotFoundError("Adjustment not found.");

    const updated = await prisma.$transaction((tx) => approveAdjustment(tx, id, { approvedByUserId: session.userId }));

    await recordAuditEvent(
      "hospital.adjustment.approved",
      session.userId,
      { adjustmentId: id },
      { facilityId, patientId: adjustment.invoice.patientId, encounterId: adjustment.invoice.encounterId }
    );
    return { adjustment: updated };
  });
}
