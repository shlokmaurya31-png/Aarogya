import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { createTransportRequest } from "@/lib/hospital/operations/service";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("operations:command:view", searchParams.get("facilityId") ?? undefined);
    const status = searchParams.get("status");
    const requests = await prisma.patientTransportRequest.findMany({ where: { facilityId, ...(status ? { status } : {}) }, orderBy: [{ priority: "desc" }, { requestedAt: "asc" }], take: 200 });
    return { requests };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("transport:request:create", body?.facilityId);
    if (!staff) throw new BadRequestError("Transport requests require a staff account.");
    if (!body?.patientId || !body?.transportType) throw new BadRequestError("patientId and transportType are required.");
    const request = await createTransportRequest({ facilityId, patientId: body.patientId, transportType: body.transportType, encounterId: body.encounterId, pickupBedId: body.pickupBedId, pickupLabel: body.pickupLabel, destinationBedId: body.destinationBedId, destinationLabel: body.destinationLabel, priority: body.priority, equipmentNote: body.equipmentNote, requestedByStaffId: staff.id, byUserId: session.userId });
    return { request };
  });
}
