import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("imaging:report:verify", body?.facilityId);

    const order = await prisma.imagingOrder.findUnique({ where: { id }, include: { encounter: true, report: true } });
    if (!order || order.encounter.facilityId !== facilityId || !order.report) throw new NotFoundError("Imaging report not found.");

    const updated = await prisma.imagingReport.update({
      where: { id: order.report.id },
      data: { verifiedByStaffId: session.userId, verifiedAt: new Date() },
    });

    await recordAuditEvent("hospital.imaging.criticalReportVerified", session.userId, { imagingOrderId: id });
    return { report: updated };
  });
}
