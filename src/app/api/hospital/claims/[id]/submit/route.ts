import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { findClaimInFacility, submitClaim } from "@/lib/hospital/billing/claims";
import { prisma } from "@/lib/db";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("insurance:claim:submit", body?.facilityId);

    const claim = await findClaimInFacility(id, facilityId);
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: claim.invoiceId } });
    const updated = await prisma.$transaction((tx) => submitClaim(tx, id));

    await recordAuditEvent(
      "hospital.claim.submitted",
      session.userId,
      { claimId: id, claimNumber: updated.claimNumber },
      { facilityId, patientId: invoice.patientId, encounterId: invoice.encounterId }
    );
    return { claim: updated };
  });
}
