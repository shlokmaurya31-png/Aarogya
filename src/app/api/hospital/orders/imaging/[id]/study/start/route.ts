import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { startStudy } from "@/lib/hospital/imagingStudyLifecycle";

/** "Claim" the study for execution (brief §23 concurrency test #1) — first technologist to call this wins. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("radiology:study:execute", body?.facilityId);
    if (!staff) throw new NotFoundError("Staff account required.");

    const order = await prisma.imagingOrder.findUnique({ where: { id }, include: { encounter: true } });
    if (!order || order.encounter.facilityId !== facilityId) throw new NotFoundError("Imaging order not found.");

    const study = await prisma.imagingStudy.findFirst({ where: { imagingOrderId: id, status: "ARRIVED" }, orderBy: { createdAt: "desc" } });
    if (!study) throw new NotFoundError("No arrived study ready to start for this order.");

    const { pregnancyScreened, allergyScreened, mriSafetyScreened, implantScreened, preparationCompleted } = body ?? {};
    const updated = await prisma.$transaction((tx) =>
      startStudy(tx, study.id, staff.id, {
        pregnancyScreened: Boolean(pregnancyScreened),
        allergyScreened: Boolean(allergyScreened),
        mriSafetyScreened: Boolean(mriSafetyScreened),
        implantScreened: Boolean(implantScreened),
        preparationCompleted: Boolean(preparationCompleted),
      })
    );

    await recordAuditEvent("hospital.imaging.studyStarted", session.userId, { imagingOrderId: id, studyId: study.id });
    return { study: updated };
  });
}
