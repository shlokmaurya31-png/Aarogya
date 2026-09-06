import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { findPaymentInFacility } from "@/lib/hospital/billing/payments";
import { requestRefund } from "@/lib/hospital/billing/refunds";

/** Requests a refund against this payment's unallocated balance (see refunds.ts's scope note). idempotencyKey required — same double-submit protection as payments. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("billing:refund:request", body?.facilityId);

    const { amountMinor, reason, idempotencyKey } = body ?? {};
    if (typeof amountMinor !== "number" || amountMinor <= 0) throw new BadRequestError("amountMinor must be a positive number.");
    if (!reason || typeof reason !== "string") throw new BadRequestError("A refund reason is required.");
    if (!idempotencyKey || typeof idempotencyKey !== "string") throw new BadRequestError("idempotencyKey is required.");

    const payment = await findPaymentInFacility(id, facilityId);

    const { refund, alreadyExisted } = await prisma.$transaction((tx) =>
      requestRefund(tx, { paymentId: id, amountMinor, reason, requestedByUserId: session.userId, idempotencyKey })
    );

    if (!alreadyExisted) {
      await recordAuditEvent(
        "hospital.refund.requested",
        session.userId,
        { refundId: refund.id, paymentId: id, amountMinor, reason },
        { facilityId, patientId: payment.patientId }
      );
    }
    return { refund, alreadyExisted };
  });
}
