import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { findInvoiceInFacility, voidInvoice } from "@/lib/hospital/billing/invoices";
import { prisma } from "@/lib/db";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("billing:invoice:void", body?.facilityId);

    const { reason } = body ?? {};
    if (!reason || typeof reason !== "string") throw new BadRequestError("A void reason is required.");

    const invoice = await findInvoiceInFacility(id, facilityId);
    const updated = await prisma.$transaction((tx) => voidInvoice(tx, id, { reason, byUserId: session.userId }));

    await recordAuditEvent(
      "hospital.invoice.voided",
      session.userId,
      { invoiceId: id, reason },
      { facilityId, patientId: invoice.patientId, encounterId: invoice.encounterId }
    );
    return { invoice: updated };
  });
}
