import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";

/** Document metadata foundation (brief §26) — metadata-only this phase, see docs/CLINICAL_CORE.md §8. */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);
    const patientId = searchParams.get("patientId");
    if (!patientId) throw new BadRequestError("patientId is required.");

    const patient = await prisma.patient.findUnique({ where: { id: patientId } });
    if (!patient || patient.facilityId !== facilityId) throw new NotFoundError("Patient not found.");

    const documents = await prisma.clinicalDocument.findMany({ where: { patientId }, orderBy: { createdAt: "desc" } });
    return { documents };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("document:manage", body?.facilityId);
    if (!staff) throw new BadRequestError("Documents must be recorded by a staff account.");

    const { patientId, encounterId, type, title, accessPolicy } = body ?? {};
    if (!patientId || !type || !title) throw new BadRequestError("patientId, type and title are required.");

    const patient = await prisma.patient.findUnique({ where: { id: patientId } });
    if (!patient || patient.facilityId !== facilityId) throw new NotFoundError("Patient not found.");

    const document = await prisma.clinicalDocument.create({
      data: {
        facilityId,
        patientId,
        encounterId,
        type,
        title,
        accessPolicy: accessPolicy ?? "CLINICAL_STAFF",
        authorStaffId: staff.id,
        uploadedByStaffId: staff.id,
      },
    });

    await recordAuditEvent("hospital.document.created", session.userId, { documentId: document.id, patientId, type });
    return { document };
  });
}
