import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { updateInfusionStatus } from "@/lib/hospital/icu";

/** Infusion state change (RUNNING/PAUSED/STOPPED) + optional rate update. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("icu:infusion:manage", body?.facilityId);
    if (!body?.status) throw new BadRequestError("status is required.");

    const infusion = await updateInfusionStatus({
      infusionId: id,
      facilityId,
      status: body.status,
      rate: body.rate !== undefined ? Number(body.rate) : undefined,
      byUserId: session.userId,
    });
    return { infusion };
  });
}
