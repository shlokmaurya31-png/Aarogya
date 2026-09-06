import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { findClaimInFacility, recordClaimDecision } from "@/lib/hospital/billing/claims";
import { prisma } from "@/lib/db";

const VALID_DECISIONS = ["UNDER_REVIEW", "APPROVED", "PARTIALLY_APPROVED", "REJECTED"];

/** Manual entry of the payer's decision — no live payer API this phase (see docs/PHASE_5_SCOPE_AND_DEFERRALS.md). */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("insurance:claim:review", body?.facilityId);

    const { status, approvedAmountMinor, denialReason } = body ?? {};
    if (!status || !VALID_DECISIONS.includes(status)) throw new BadRequestError(`status must be one of ${VALID_DECISIONS.join(", ")}.`);

    const claim = await findClaimInFacility(id, facilityId);
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: claim.invoiceId } });
    const updated = await prisma.$transaction((tx) => recordClaimDecision(tx, id, { status, approvedAmountMinor, denialReason }));

    await recordAuditEvent(
      "hospital.claim.decided",
      session.userId,
      { claimId: id, status, approvedAmountMinor, denialReason },
      { facilityId, patientId: invoice.patientId, encounterId: invoice.encounterId }
    );
    return { claim: updated };
  });
}
