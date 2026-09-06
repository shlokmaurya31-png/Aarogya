import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { findClaimInFacility, settleClaim } from "@/lib/hospital/billing/claims";
import { prisma } from "@/lib/db";

/** Records that the payer's decision is final and settled. The actual money arriving is recorded separately via POST /api/hospital/payments with method=INSURANCE_SETTLEMENT, then allocated to the invoice. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("insurance:claim:review", body?.facilityId);

    const { settledAmountMinor } = body ?? {};
    if (typeof settledAmountMinor !== "number" || settledAmountMinor < 0) throw new BadRequestError("settledAmountMinor must be a non-negative number.");

    const claim = await findClaimInFacility(id, facilityId);
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: claim.invoiceId } });
    const updated = await prisma.$transaction((tx) => settleClaim(tx, id, { settledAmountMinor }));

    await recordAuditEvent(
      "hospital.claim.settled",
      session.userId,
      { claimId: id, settledAmountMinor },
      { facilityId, patientId: invoice.patientId, encounterId: invoice.encounterId }
    );
    return { claim: updated };
  });
}
