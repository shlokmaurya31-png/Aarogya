import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { transitionSurgery, SurgeryTransitionError } from "@/lib/hospital/surgery";
import type { SurgeryStatus } from "@prisma/client";

const REVIEW_STATES = ["REVIEWED", "APPROVED"];

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const to = body?.to as SurgeryStatus | undefined;
    if (!to) throw new BadRequestError("to is required.");
    // review/approve/cancel gate; scheduling/start/complete have dedicated routes.
    const permission = to === "CANCELLED" ? "ot:procedure:manage" : REVIEW_STATES.includes(to) ? "ot:procedure:review" : "ot:procedure:manage";
    const { session, facilityId, staff } = await requireFacilityStaff(permission, body?.facilityId);
    if (!staff) throw new BadRequestError("Must be performed by a staff account.");
    try {
      const surgery = await transitionSurgery({ surgeryId: id, facilityId, to, actorStaffId: staff.id, reason: body?.reason, byUserId: session.userId });
      return { surgery };
    } catch (err) {
      if (err instanceof SurgeryTransitionError) throw new BadRequestError(err.message);
      throw err;
    }
  });
}
