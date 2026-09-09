import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { requestSurgery } from "@/lib/hospital/surgery";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("clinical:chart:read", searchParams.get("facilityId") ?? undefined);
    const status = searchParams.get("status");
    const patientId = searchParams.get("patientId");
    const surgeries = await prisma.surgery.findMany({
      where: { facilityId, ...(status ? { status: status as never } : {}), ...(patientId ? { patientId } : {}) },
      include: { patient: true, schedule: { include: { operatingTheatre: true } } },
      orderBy: { createdAt: "desc" }, take: 100,
    });
    return { surgeries };
  });
}
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("ot:procedure:create", body?.facilityId);
    if (!staff) throw new BadRequestError("Surgery requests must be made by a staff account.");
    if (!body?.patientId || !body?.encounterId) throw new BadRequestError("patientId and encounterId are required.");
    const patient = await prisma.patient.findUnique({ where: { id: body.patientId } });
    if (!patient || patient.facilityId !== facilityId) throw new NotFoundError("Patient not found.");
    const surgery = await requestSurgery({
      facilityId, patientId: body.patientId, encounterId: body.encounterId, procedureId: body.procedureId, procedureName: body.procedureName,
      indication: body.indication, laterality: body.laterality, urgency: body.urgency, requestedDate: body.requestedDate ? new Date(body.requestedDate) : undefined,
      requestedByStaffId: staff.id, byUserId: session.userId,
    });
    return { surgery };
  });
}
