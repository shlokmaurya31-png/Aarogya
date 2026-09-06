import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { findInvoiceInFacility, addChargeToInvoice } from "@/lib/hospital/billing/invoices";
import { prisma } from "@/lib/db";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("billing:invoice:create", body?.facilityId);

    const { chargeId } = body ?? {};
    if (!chargeId) throw new BadRequestError("chargeId is required.");

    const invoice = await findInvoiceInFacility(id, facilityId);
    const updated = await prisma.$transaction((tx) => addChargeToInvoice(tx, id, chargeId));

    await recordAuditEvent(
      "hospital.invoice.lineAdded",
      session.userId,
      { invoiceId: id, chargeId },
      { facilityId, patientId: invoice.patientId, encounterId: invoice.encounterId }
    );
    return { invoice: updated };
  });
}
