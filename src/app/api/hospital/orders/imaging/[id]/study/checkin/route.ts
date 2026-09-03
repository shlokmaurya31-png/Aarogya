import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { checkInStudy } from "@/lib/hospital/imagingStudyLifecycle";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("radiology:study:execute", body?.facilityId);
    if (!staff) throw new NotFoundError("Staff account required.");

    const order = await prisma.imagingOrder.findUnique({ where: { id }, include: { encounter: true } });
    if (!order || order.encounter.facilityId !== facilityId) throw new NotFoundError("Imaging order not found.");

    const study = await prisma.imagingStudy.findFirst({ where: { imagingOrderId: id, status: "SCHEDULED" }, orderBy: { createdAt: "desc" } });
    if (!study) throw new NotFoundError("No scheduled study awaiting arrival for this order.");

    const updated = await prisma.$transaction((tx) => checkInStudy(tx, study.id));

    await recordAuditEvent("hospital.imaging.studyCheckedIn", session.userId, { imagingOrderId: id, studyId: study.id });
    return { study: updated };
  });
}
