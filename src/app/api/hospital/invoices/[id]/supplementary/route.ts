import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { findInvoiceInFacility, draftSupplementaryInvoice } from "@/lib/hospital/billing/invoices";

/** POST: draft a supplementary invoice (or debit note, per facility configuration) collecting the encounter's late charges. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("billing:invoice:create", body?.facilityId);
    const original = await findInvoiceInFacility(id, facilityId);
    const supplementary = await prisma.$transaction((tx) => draftSupplementaryInvoice(tx, { originalInvoiceId: original.id, generatedByUserId: session.userId }));
    await recordAuditEvent("hospital.billing.supplementaryDrafted", session.userId, { originalInvoiceId: original.id, invoiceId: supplementary.id, documentType: supplementary.documentType }, { facilityId, patientId: original.patientId, encounterId: original.encounterId });
    return { invoice: supplementary };
  });
}
