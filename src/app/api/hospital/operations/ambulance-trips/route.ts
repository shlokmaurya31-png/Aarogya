import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { createAmbulanceTrip } from "@/lib/hospital/operations/service";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("operations:command:view", searchParams.get("facilityId") ?? undefined);
    const status = searchParams.get("status");
    const trips = await prisma.ambulanceTrip.findMany({ where: { facilityId, ...(status ? { status } : {}) }, orderBy: { requestedAt: "desc" }, take: 200 });
    return { trips };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("ambulance:dispatch", body?.facilityId);
    if (!staff) throw new BadRequestError("Ambulance trips require a staff account.");
    if (!body?.origin || !body?.destination) throw new BadRequestError("origin and destination are required.");
    const trip = await createAmbulanceTrip({ facilityId, origin: body.origin, destination: body.destination, patientId: body.patientId, encounterId: body.encounterId, crewNote: body.crewNote, requestedByStaffId: staff.id, byUserId: session.userId });
    return { trip };
  });
}
