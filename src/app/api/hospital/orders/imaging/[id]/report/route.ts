import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError, BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { isImagingOrderTransitionAllowed, InvalidImagingOrderTransitionError } from "@/lib/hospital/diagnosticsLifecycle";
import { enterReport } from "@/lib/hospital/imagingReportLifecycle";

const MAX_TEXT_LENGTH = 10_000;

/**
 * Structured report entry (brief §11-12, extended from the Milestone A
 * single-value flow). Requires the order's study to be COMPLETED —
 * enforced via the ImagingOrder-level ACQUIRED gate, which
 * imagingStudyLifecycle.ts's completeStudy() is the only thing that sets.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("imaging:report:enter", body?.facilityId);
    if (!staff) throw new BadRequestError("Reports must be entered by a staff account.");

    const order = await prisma.imagingOrder.findUnique({ where: { id }, include: { encounter: true } });
    if (!order || order.encounter.facilityId !== facilityId) throw new NotFoundError("Imaging order not found.");
    if (!isImagingOrderTransitionAllowed(order.status, "REPORTED")) {
      throw new InvalidImagingOrderTransitionError(order.status, "REPORTED");
    }

    const { indication, technique, findings, impression, recommendations, isCritical } = body ?? {};
    if (!findings || !impression) throw new BadRequestError("findings and impression are required.");
    if (typeof findings !== "string" || findings.length > MAX_TEXT_LENGTH) throw new BadRequestError(`findings must be a string of at most ${MAX_TEXT_LENGTH} characters.`);
    if (typeof impression !== "string" || impression.length > MAX_TEXT_LENGTH) throw new BadRequestError(`impression must be a string of at most ${MAX_TEXT_LENGTH} characters.`);
    // Milestone E hardening — see the identical rationale in
    // orders/lab/[id]/result/route.ts (Boolean("false") === true footgun).
    if (isCritical !== undefined && isCritical !== null && typeof isCritical !== "boolean") {
      throw new BadRequestError("isCritical must be a boolean.");
    }

    const study = await prisma.imagingStudy.findFirst({ where: { imagingOrderId: id, status: "COMPLETED" }, orderBy: { createdAt: "desc" } });

    const report = await prisma.$transaction((tx) =>
      enterReport(tx, {
        imagingOrderId: id,
        studyId: study?.id ?? null,
        indication,
        technique,
        findings,
        impression,
        recommendations,
        isCritical: isCritical === true,
        reportedByStaffId: staff.id,
      })
    );

    await recordAuditEvent("hospital.imaging.reportEntered", session.userId, { imagingOrderId: id, reportId: report.id, isCritical: isCritical === true });
    return { report };
  });
}
