import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { deactivateCoverage } from "@/lib/hospital/billing/coverage";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("insurance:coverage:manage", body?.facilityId);

    const coverage = await prisma.patientCoverage.findUnique({ where: { id }, include: { patient: true } });
    if (!coverage || coverage.patient.facilityId !== facilityId) throw new NotFoundError("Coverage not found.");

    const updated = await prisma.$transaction((tx) => deactivateCoverage(tx, id));
    await recordAuditEvent(
      "hospital.insurance.coverageDeactivated",
      session.userId,
      { coverageId: id },
      { facilityId, patientId: coverage.patientId }
    );
    return { coverage: updated };
  });
}
