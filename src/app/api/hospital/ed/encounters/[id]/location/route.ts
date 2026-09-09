import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { assignEdLocation, releaseEdLocation } from "@/lib/hospital/emergency";

/** Assign (POST) or release (DELETE) the encounter's current ED location. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("ed:location:manage", body?.facilityId);
    if (!staff) throw new BadRequestError("Location assignment requires a staff account.");
    const location = await assignEdLocation({ encounterId: id, facilityId, bedId: body?.bedId, areaLabel: body?.areaLabel, assignedByStaffId: staff.id, byUserId: session.userId });
    return { location };
  });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { session, facilityId } = await requireFacilityStaff("ed:location:manage", searchParams.get("facilityId") ?? undefined);
    return await releaseEdLocation({ encounterId: id, facilityId, byUserId: session.userId });
  });
}
