import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { scheduleSurgery, cancelSchedule, SurgeryScheduleConflictError } from "@/lib/hospital/surgery";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("ot:procedure:schedule", body?.facilityId);
    if (!staff) throw new BadRequestError("Must be performed by a staff account.");
    if (!body?.operatingTheatreId || !body?.startAt || !body?.endAt) throw new BadRequestError("operatingTheatreId, startAt and endAt are required.");
    try {
      const schedule = await scheduleSurgery({ surgeryId: id, facilityId, operatingTheatreId: body.operatingTheatreId, startAt: new Date(body.startAt), endAt: new Date(body.endAt), schedulerStaffId: staff.id, notes: body.notes, byUserId: session.userId });
      return { schedule };
    } catch (err) {
      if (err instanceof SurgeryScheduleConflictError) throw new BadRequestError(err.message);
      throw err;
    }
  });
}
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { session, facilityId } = await requireFacilityStaff("ot:procedure:schedule", searchParams.get("facilityId") ?? undefined);
    const schedule = await cancelSchedule({ surgeryId: id, facilityId, byUserId: session.userId });
    return { schedule };
  });
}
