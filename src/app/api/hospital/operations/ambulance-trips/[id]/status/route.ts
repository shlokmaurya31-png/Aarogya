import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { transitionAmbulanceTrip } from "@/lib/hospital/operations/service";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("ambulance:dispatch", body?.facilityId);
    if (!body?.to) throw new BadRequestError("to (target status) is required.");
    return { trip: await transitionAmbulanceTrip({ tripId: id, facilityId, to: body.to, notes: body.notes, byUserId: session.userId }) };
  });
}
