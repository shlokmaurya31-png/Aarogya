import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { findPaymentInFacility, voidPayment } from "@/lib/hospital/billing/payments";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("billing:payment:void", body?.facilityId);

    const { reason } = body ?? {};
    if (!reason || typeof reason !== "string") throw new BadRequestError("A void reason is required.");

    const payment = await findPaymentInFacility(id, facilityId);
    const updated = await prisma.$transaction((tx) => voidPayment(tx, id, { reason, byUserId: session.userId }));

    await recordAuditEvent(
      "hospital.payment.voided",
      session.userId,
      { paymentId: id, reason },
      { facilityId, patientId: payment.patientId }
    );
    return { payment: updated };
  });
}
