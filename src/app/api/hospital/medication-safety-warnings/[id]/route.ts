import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { acknowledgeSafetyWarning, RequiresOverrideError } from "@/lib/hospital/medicationLifecycle";

/** Acknowledge or override a medication safety warning (brief §18) — a DANGER-severity warning requires an explicit override reason. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("clinical:order:medication", body?.facilityId);
    if (!staff) throw new BadRequestError("Must be acknowledged by a staff account.");

    const warning = await prisma.medicationSafetyWarning.findUnique({
      where: { id },
      include: { medicationOrder: { include: { encounter: true } } },
    });
    if (!warning || warning.medicationOrder.encounter.facilityId !== facilityId) throw new NotFoundError("Safety warning not found.");

    try {
      const updated = await acknowledgeSafetyWarning(id, staff.id, session.userId, body?.overrideReason);
      return { warning: updated };
    } catch (err) {
      if (err instanceof RequiresOverrideError) throw new BadRequestError(err.message);
      throw err;
    }
  });
}
