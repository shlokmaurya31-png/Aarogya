import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { verifyReport } from "@/lib/hospital/imagingReportLifecycle";

/** Report verification/finalization (brief §11). Guarded concurrent-safe — two radiologists verifying the same report simultaneously: one wins, one is rejected. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; reportId: string }> }) {
  return withApiErrors(async () => {
    const { id, reportId } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("imaging:report:verify", body?.facilityId);
    if (!staff) throw new NotFoundError("Staff account required.");

    const report = await prisma.imagingReport.findUnique({ where: { id: reportId }, include: { imagingOrder: { include: { encounter: true } } } });
    if (!report || report.imagingOrderId !== id || report.imagingOrder.encounter.facilityId !== facilityId) throw new NotFoundError("Imaging report not found.");

    const updated = await prisma.$transaction((tx) => verifyReport(tx, reportId, staff.id));

    await recordAuditEvent("hospital.imaging.reportVerified", session.userId, { imagingOrderId: id, reportId });
    return { report: updated };
  });
}
