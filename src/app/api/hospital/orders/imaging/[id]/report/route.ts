import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError, BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("imaging:report:enter", body?.facilityId);
    if (!staff) throw new BadRequestError("Reports must be entered by a staff account.");

    const order = await prisma.imagingOrder.findUnique({ where: { id }, include: { encounter: true } });
    if (!order || order.encounter.facilityId !== facilityId) throw new NotFoundError("Imaging order not found.");

    const { findings, impression, isCritical } = body ?? {};
    if (!findings || !impression) throw new BadRequestError("findings and impression are required.");

    const report = await prisma.$transaction(async (tx) => {
      const created = await tx.imagingReport.create({
        data: { imagingOrderId: id, findings, impression, isCritical: Boolean(isCritical), reportedByStaffId: staff.id },
      });
      await tx.imagingOrder.update({ where: { id }, data: { status: "REPORTED" } });
      return created;
    });

    await recordAuditEvent("hospital.imaging.reportEntered", session.userId, { imagingOrderId: id, isCritical: Boolean(isCritical) });
    return { report };
  });
}
