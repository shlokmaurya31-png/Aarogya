import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { findPaymentInFacility, allocatePayment } from "@/lib/hospital/billing/payments";
import { findInvoiceInFacility } from "@/lib/hospital/billing/invoices";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("billing:payment:record", body?.facilityId);

    const { invoiceId, amountMinor } = body ?? {};
    if (!invoiceId) throw new BadRequestError("invoiceId is required.");
    if (typeof amountMinor !== "number" || amountMinor <= 0) throw new BadRequestError("amountMinor must be a positive number.");

    const payment = await findPaymentInFacility(id, facilityId);
    const invoice = await findInvoiceInFacility(invoiceId, facilityId);

    const updated = await prisma.$transaction((tx) => allocatePayment(tx, { paymentId: id, invoiceId, amountMinor, allocatedByUserId: session.userId }));

    await recordAuditEvent(
      "hospital.payment.allocated",
      session.userId,
      { paymentId: id, invoiceId, amountMinor },
      { facilityId, patientId: payment.patientId, encounterId: invoice.encounterId }
    );
    return { payment: updated };
  });
}
