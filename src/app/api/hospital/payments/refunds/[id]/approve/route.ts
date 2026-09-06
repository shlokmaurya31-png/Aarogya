import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { findRefundInFacility, approveRefund } from "@/lib/hospital/billing/refunds";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("billing:refund:approve", body?.facilityId);

    const refund = await findRefundInFacility(id, facilityId);
    const updated = await prisma.$transaction((tx) => approveRefund(tx, id, { approvedByUserId: session.userId }));

    await recordAuditEvent(
      "hospital.refund.approved",
      session.userId,
      { refundId: id },
      { facilityId, patientId: refund.payment.patientId }
    );
    return { refund: updated };
  });
}
