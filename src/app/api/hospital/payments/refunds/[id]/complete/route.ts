import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { findRefundInFacility, completeRefund } from "@/lib/hospital/billing/refunds";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("billing:refund:approve", body?.facilityId);

    const refund = await findRefundInFacility(id, facilityId);
    const updated = await prisma.$transaction((tx) => completeRefund(tx, id));

    await recordAuditEvent(
      "hospital.refund.completed",
      session.userId,
      { refundId: id, amountMinor: updated.amountMinor },
      { facilityId, patientId: refund.payment.patientId }
    );
    return { refund: updated };
  });
}
