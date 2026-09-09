import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { requestBlood, buildBloodRequestBoard } from "@/lib/hospital/blood";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("clinical:chart:read", searchParams.get("facilityId") ?? undefined);
    const patientId = searchParams.get("patientId");
    if (patientId) {
      const requests = await prisma.bloodRequest.findMany({ where: { facilityId, patientId }, include: { patient: true }, orderBy: { requestedAt: "desc" }, take: 100 });
      return { requests };
    }
    return { board: await buildBloodRequestBoard(facilityId) };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("blood:request:create", body?.facilityId);
    if (!staff) throw new BadRequestError("Blood requests must be made by a staff account.");
    if (!body?.patientId || !body?.encounterId) throw new BadRequestError("patientId and encounterId are required.");
    const patient = await prisma.patient.findUnique({ where: { id: body.patientId } });
    if (!patient || patient.facilityId !== facilityId) throw new NotFoundError("Patient not found.");
    const request = await requestBlood({
      facilityId, patientId: body.patientId, encounterId: body.encounterId, productId: body.productId, productName: body.productName,
      quantity: body.quantity, priority: body.priority, indication: body.indication, requiredBy: body.requiredBy ? new Date(body.requiredBy) : undefined,
      surgeryId: body.surgeryId, requestedByStaffId: staff.id, byUserId: session.userId,
    });
    return { request };
  });
}
