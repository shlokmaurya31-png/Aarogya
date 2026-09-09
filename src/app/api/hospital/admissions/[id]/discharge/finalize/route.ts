import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { finalizeDischarge, DischargeNotReadyError, InvalidEncounterTransitionError } from "@/lib/hospital/admission";

const DISCHARGE_TYPES = ["ROUTINE", "LAMA", "DAMA", "ABSCONDED", "DEATH", "TRANSFER", "REFERRAL"];

/** Requires clinician sign-off (brief §37) and every readiness flag true; frees the bed to CLEANING. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("admission:discharge:finalize", body?.facilityId);

    const admission = await prisma.admission.findUnique({ where: { id }, include: { encounter: true, discharge: true } });
    if (!admission || admission.encounter.facilityId !== facilityId || !admission.discharge) throw new NotFoundError("Discharge not found.");

    const summary = body?.dischargeSummary ?? {};
    const dischargeType = body?.dischargeType as string | undefined;
    if (dischargeType && !DISCHARGE_TYPES.includes(dischargeType)) {
      throw new BadRequestError(`dischargeType must be one of ${DISCHARGE_TYPES.join(", ")}.`);
    }

    try {
      const discharge = await finalizeDischarge(admission.discharge.id, session.userId, summary, dischargeType || undefined);
      return { discharge };
    } catch (err) {
      if (err instanceof DischargeNotReadyError || err instanceof InvalidEncounterTransitionError) throw new BadRequestError(err.message);
      throw err;
    }
  });
}
