import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { transitionEncounter, InvalidEncounterTransitionError } from "@/lib/hospital/encounterStateMachine";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("encounter:triage", body?.facilityId);

    const encounter = await prisma.encounter.findUnique({ where: { id } });
    if (!encounter || encounter.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");

    try {
      const updated = await transitionEncounter(id, "CANCELLED", { byUserId: session.userId, reason: body?.reason ?? "No reason given." });
      return { encounter: updated };
    } catch (err) {
      if (err instanceof InvalidEncounterTransitionError) throw new BadRequestError(err.message);
      throw err;
    }
  });
}
