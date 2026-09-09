import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { updateResuscitation } from "@/lib/hospital/emergency";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("ed:resuscitation:manage", body?.facilityId);
    if (!staff) throw new BadRequestError("Resuscitation update requires a staff account.");
    if (!body?.to) throw new BadRequestError("to (target status) is required.");
    const resuscitation = await updateResuscitation({ resuscitationId: id, facilityId, to: body.to, actorStaffId: staff.id, notes: body?.notes, byUserId: session.userId });
    return { resuscitation };
  });
}
