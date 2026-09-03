import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { acknowledgeReport } from "@/lib/hospital/imagingReportLifecycle";

/** Critical-finding acknowledgement (brief §13) — deliberately separate from verify; clears the active alert. Guarded concurrent-safe. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; reportId: string }> }) {
  return withApiErrors(async () => {
    const { id, reportId } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("imaging:report:acknowledge", body?.facilityId);
    if (!staff) throw new NotFoundError("Staff account required.");

    const report = await prisma.imagingReport.findUnique({ where: { id: reportId }, include: { imagingOrder: { include: { encounter: true } } } });
    if (!report || report.imagingOrderId !== id || report.imagingOrder.encounter.facilityId !== facilityId) throw new NotFoundError("Imaging report not found.");

    const updated = await prisma.$transaction((tx) => acknowledgeReport(tx, reportId, staff.id));

    await recordAuditEvent("hospital.imaging.criticalFindingAcknowledged", session.userId, { imagingOrderId: id, reportId });
    return { report: updated };
  });
}
