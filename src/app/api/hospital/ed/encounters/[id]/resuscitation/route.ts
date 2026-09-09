import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { activateResuscitation } from "@/lib/hospital/emergency";

/** Explicitly activate the high-acuity/resuscitation workflow (never inferred from vitals). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("ed:resuscitation:manage", body?.facilityId);
    if (!staff) throw new BadRequestError("Resuscitation activation requires a staff account.");
    const resuscitation = await activateResuscitation({ encounterId: id, facilityId, activatedByStaffId: staff.id, reason: body?.reason, byUserId: session.userId });
    return { resuscitation };
  });
}
