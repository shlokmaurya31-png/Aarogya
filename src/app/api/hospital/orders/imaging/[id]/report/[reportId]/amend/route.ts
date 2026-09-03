import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError, BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { amendReport } from "@/lib/hospital/imagingReportLifecycle";

const MAX_TEXT_LENGTH = 10_000;

/** Amendment (brief §11) — the previous verified version is preserved unchanged, never overwritten. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; reportId: string }> }) {
  return withApiErrors(async () => {
    const { id, reportId } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("imaging:report:amend", body?.facilityId);
    if (!staff) throw new NotFoundError("Staff account required.");

    const report = await prisma.imagingReport.findUnique({ where: { id: reportId }, include: { imagingOrder: { include: { encounter: true } } } });
    if (!report || report.imagingOrderId !== id || report.imagingOrder.encounter.facilityId !== facilityId) throw new NotFoundError("Imaging report not found.");

    const { findings, impression, recommendations, isCritical, reason } = body ?? {};
    if (!findings || !impression) throw new BadRequestError("findings and impression are required.");
    if (!reason) throw new BadRequestError("An amendment reason is required.");
    if (typeof findings !== "string" || findings.length > MAX_TEXT_LENGTH) throw new BadRequestError(`findings must be a string of at most ${MAX_TEXT_LENGTH} characters.`);
    if (typeof impression !== "string" || impression.length > MAX_TEXT_LENGTH) throw new BadRequestError(`impression must be a string of at most ${MAX_TEXT_LENGTH} characters.`);
    if (typeof reason !== "string" || reason.length > MAX_TEXT_LENGTH) throw new BadRequestError(`reason must be a string of at most ${MAX_TEXT_LENGTH} characters.`);
    // Milestone E hardening — see the identical rationale in
    // orders/lab/[id]/result/[resultId]/amend/route.ts.
    if (isCritical !== undefined && isCritical !== null && typeof isCritical !== "boolean") {
      throw new BadRequestError("isCritical must be a boolean.");
    }

    const { original, amended } = await prisma.$transaction((tx) =>
      amendReport(tx, reportId, { findings, impression, recommendations, isCritical, reason, amendedByStaffId: staff.id })
    );

    await recordAuditEvent("hospital.imaging.reportAmended", session.userId, { imagingOrderId: id, previousReportId: original.id, amendedReportId: amended.id, reason });
    return { original, amended };
  });
}
