import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError, BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { cancelStudy } from "@/lib/hospital/imagingStudyLifecycle";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("radiology:schedule", body?.facilityId);
    if (!staff) throw new NotFoundError("Staff account required.");

    const order = await prisma.imagingOrder.findUnique({ where: { id }, include: { encounter: true } });
    if (!order || order.encounter.facilityId !== facilityId) throw new NotFoundError("Imaging order not found.");

    const { reason } = body ?? {};
    if (!reason) throw new BadRequestError("A cancellation reason is required.");

    const study = await prisma.imagingStudy.findFirst({ where: { imagingOrderId: id, status: { in: ["SCHEDULED", "ARRIVED"] } }, orderBy: { createdAt: "desc" } });
    if (!study) throw new NotFoundError("No cancellable study for this order.");

    const updated = await prisma.$transaction((tx) => cancelStudy(tx, study.id, reason));

    await recordAuditEvent("hospital.imaging.studyCancelled", session.userId, { imagingOrderId: id, studyId: study.id, reason });
    return { study: updated };
  });
}
