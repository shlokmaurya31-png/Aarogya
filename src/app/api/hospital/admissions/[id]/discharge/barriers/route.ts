import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { computeDischargeBarriers, bucketDischarge } from "@/lib/hospital/dischargeBarrierEngine";
import { computeFinancialClearance } from "@/lib/hospital/billing/financialClearance";

/** Discharge barrier engine (brief §38) — tells staff WHY, not just THAT discharge is pending. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("encounter:read", searchParams.get("facilityId") ?? undefined);

    const admission = await prisma.admission.findUnique({ where: { id }, include: { encounter: true, discharge: true } });
    if (!admission || admission.encounter.facilityId !== facilityId || !admission.discharge) throw new NotFoundError("Discharge not found.");

    const barriers = await computeDischargeBarriers(admission.discharge.id);
    const { bucket, label } = bucketDischarge(barriers);
    // Informational only — does not gate discharge. billingReady/insuranceReady
    // (part of `barriers` above) remain the only flags that actually block
    // finalizeDischarge; this is read-only additional context.
    const financialClearance = await computeFinancialClearance(admission.encounterId);
    return { barriers, bucket, bucketLabel: label, financialClearance };
  });
}
