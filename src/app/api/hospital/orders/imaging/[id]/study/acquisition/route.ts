import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordStudyAcquisition } from "@/lib/hospital/diagnosticsAdvanced";

/**
 * Record a study's acquisition + DICOM/PACS metadata (technologist workflow).
 * The [id] is the imaging ORDER; the study is derived server-side and must
 * belong to the caller's facility (never trust a client-supplied study id).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id: imagingOrderId } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("radiology:study:execute", body?.facilityId);
    if (!staff) throw new BadRequestError("Acquisition requires a radiology staff account.");

    const study = await prisma.imagingStudy.findFirst({ where: { imagingOrderId, facilityId }, orderBy: { createdAt: "desc" } });
    if (!study) throw new NotFoundError("No study for this imaging order in this facility.");
    const updated = await recordStudyAcquisition({
      studyId: study.id, facilityId, performedByStaffId: staff.id, studyInstanceUid: body?.studyInstanceUid, seriesUid: body?.seriesUid,
      numberOfImages: body?.numberOfImages != null ? Number(body.numberOfImages) : undefined, technicalNotes: body?.technicalNotes, dicomMetadata: body?.dicomMetadata, byUserId: session.userId,
    });
    return { study: updated };
  });
}
