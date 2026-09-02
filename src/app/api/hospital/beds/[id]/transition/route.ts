import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { BedStatus } from "@prisma/client";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { transitionBed, InvalidBedTransitionError } from "@/lib/hospital/bed";
import { recordAuditEvent } from "@/lib/auth/audit";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { session, facilityId } = await requireFacilityStaff("bed:manage");
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const toStatus = body?.toStatus as BedStatus | undefined;
    if (!toStatus) throw new BadRequestError("toStatus is required.");

    const bed = await prisma.bed.findUnique({ where: { id } });
    if (!bed || bed.facilityId !== facilityId) throw new NotFoundError("Bed not found.");

    try {
      const updated = await transitionBed(id, toStatus, { reason: body?.reason, byUserId: session.userId });
      await recordAuditEvent("hospital.bed.stateChanged", session.userId, { bedId: id, toStatus });
      return { bed: updated };
    } catch (err) {
      if (err instanceof InvalidBedTransitionError) throw new BadRequestError(err.message);
      throw err;
    }
  });
}
