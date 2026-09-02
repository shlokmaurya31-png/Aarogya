import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { acknowledgeHandoff, HandoffAlreadyAcknowledgedError } from "@/lib/hospital/handoff";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("handoff:manage", body?.facilityId);
    if (!staff) throw new BadRequestError("Must be acknowledged by a staff account.");

    const handoff = await prisma.clinicalHandoff.findUnique({ where: { id } });
    if (!handoff || handoff.facilityId !== facilityId) throw new NotFoundError("Handoff not found.");

    try {
      const updated = await acknowledgeHandoff(id, staff.id, session.userId);
      return { handoff: updated };
    } catch (err) {
      if (err instanceof HandoffAlreadyAcknowledgedError) throw new BadRequestError(err.message);
      throw err;
    }
  });
}
