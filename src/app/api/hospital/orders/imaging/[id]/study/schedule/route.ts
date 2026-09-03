import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError, BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { scheduleStudy } from "@/lib/hospital/imagingStudyLifecycle";

/** Schedules the study for an imaging order (brief §8) — conflict-checked against the resource+timestamp inside the transaction. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("radiology:schedule", body?.facilityId);
    if (!staff) throw new NotFoundError("Staff account required.");

    const order = await prisma.imagingOrder.findUnique({ where: { id }, include: { encounter: true } });
    if (!order || order.encounter.facilityId !== facilityId) throw new NotFoundError("Imaging order not found.");
    if (order.status !== "ORDERED") throw new BadRequestError(`Order is ${order.status}, not ORDERED — cannot schedule.`);

    const { resourceId, scheduledAt, bodyRegion, contrastRequired } = body ?? {};
    if (!scheduledAt) throw new BadRequestError("scheduledAt is required.");

    if (resourceId) {
      const resource = await prisma.imagingResource.findUnique({ where: { id: resourceId } });
      if (!resource || resource.facilityId !== facilityId) throw new NotFoundError("Imaging resource not found.");
    }

    const study = await prisma.$transaction((tx) =>
      scheduleStudy(tx, {
        imagingOrderId: id,
        facilityId,
        patientId: order.patientId,
        encounterId: order.encounterId,
        modality: order.modality,
        bodyRegion,
        resourceId: resourceId ?? null,
        scheduledAt: new Date(scheduledAt),
        contrastRequired: Boolean(contrastRequired),
      })
    );

    await recordAuditEvent("hospital.imaging.scheduled", session.userId, { imagingOrderId: id, studyId: study.id, resourceId: resourceId ?? null, scheduledAt });
    return { study };
  });
}
