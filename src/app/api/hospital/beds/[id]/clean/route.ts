import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError, BadRequestError } from "@/lib/auth/rbac";
import { completeBedCleaning } from "@/lib/hospital/admission";

/** Bed <-> housekeeping integration (brief §50): discharged -> cleaning -> inspection -> available. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("bed:manage", body?.facilityId);

    const bed = await prisma.bed.findUnique({ where: { id } });
    if (!bed || bed.facilityId !== facilityId) throw new NotFoundError("Bed not found.");

    try {
      const updated = await completeBedCleaning(id, session.userId);
      return { bed: updated };
    } catch {
      throw new BadRequestError("Bed is not in CLEANING state.");
    }
  });
}
