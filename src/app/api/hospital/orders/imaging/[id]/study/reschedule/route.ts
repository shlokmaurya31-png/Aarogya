import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError, BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { rescheduleStudy } from "@/lib/hospital/imagingStudyLifecycle";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("radiology:schedule", body?.facilityId);
    if (!staff) throw new NotFoundError("Staff account required.");

    const order = await prisma.imagingOrder.findUnique({ where: { id }, include: { encounter: true } });
    if (!order || order.encounter.facilityId !== facilityId) throw new NotFoundError("Imaging order not found.");

    const { scheduledAt, resourceId } = body ?? {};
    if (!scheduledAt) throw new BadRequestError("scheduledAt is required.");
    const parsedScheduledAt = new Date(scheduledAt);
    if (Number.isNaN(parsedScheduledAt.getTime())) throw new BadRequestError("scheduledAt must be a valid date.");
    const oneYearFromNow = Date.now() + 365 * 24 * 60 * 60 * 1000;
    if (parsedScheduledAt.getTime() > oneYearFromNow) throw new BadRequestError("scheduledAt is too far in the future.");

    // Milestone E hardening — schedule/route.ts already validates a
    // client-supplied resourceId belongs to the caller's facility before
    // accepting it; this sibling route didn't, letting a study be
    // rescheduled onto another facility's imaging resource (cross-tenant
    // IDOR — the resource FK itself doesn't care which facility owns it).
    if (resourceId) {
      const resource = await prisma.imagingResource.findUnique({ where: { id: resourceId } });
      if (!resource || resource.facilityId !== facilityId) throw new NotFoundError("Imaging resource not found.");
    }

    const study = await prisma.imagingStudy.findFirst({ where: { imagingOrderId: id, status: "SCHEDULED" }, orderBy: { createdAt: "desc" } });
    if (!study) throw new NotFoundError("No scheduled study to reschedule for this order.");

    const updated = await prisma.$transaction((tx) => rescheduleStudy(tx, study.id, resourceId ?? study.resourceId, parsedScheduledAt));

    await recordAuditEvent("hospital.imaging.rescheduled", session.userId, { imagingOrderId: id, studyId: study.id, scheduledAt });
    return { study: updated };
  });
}
