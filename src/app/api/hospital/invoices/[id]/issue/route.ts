import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { findInvoiceInFacility, issueInvoice } from "@/lib/hospital/billing/invoices";
import { prisma } from "@/lib/db";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("billing:invoice:issue", body?.facilityId);

    const { discountMinor, taxRatePercent, dueAt } = body ?? {};
    if (discountMinor !== undefined && (typeof discountMinor !== "number" || discountMinor < 0)) {
      throw new BadRequestError("discountMinor must be a non-negative number.");
    }
    if (taxRatePercent !== undefined && (typeof taxRatePercent !== "number" || taxRatePercent < 0 || taxRatePercent > 100)) {
      throw new BadRequestError("taxRatePercent must be a number between 0 and 100.");
    }

    const invoice = await findInvoiceInFacility(id, facilityId);
    const updated = await prisma.$transaction((tx) =>
      issueInvoice(tx, id, { discountMinor, taxRatePercent, dueAt: dueAt ? new Date(dueAt) : undefined })
    );

    await recordAuditEvent(
      "hospital.invoice.issued",
      session.userId,
      { invoiceId: id, invoiceNumber: updated.invoiceNumber, totalMinor: updated.totalMinor },
      { facilityId, patientId: invoice.patientId, encounterId: invoice.encounterId }
    );
    return { invoice: updated };
  });
}
