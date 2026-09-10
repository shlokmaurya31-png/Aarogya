import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { dispatchAmbulanceTrip } from "@/lib/hospital/operations/service";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("ambulance:dispatch", body?.facilityId);
    if (!staff) throw new BadRequestError("Dispatch requires a staff account.");
    if (!body?.ambulanceId) throw new BadRequestError("ambulanceId is required.");
    return { trip: await dispatchAmbulanceTrip({ tripId: id, facilityId, ambulanceId: body.ambulanceId, dispatchedByStaffId: staff.id, crewNote: body.crewNote, byUserId: session.userId }) };
  });
}
