import { updateEncounterDetails } from "@/lib/hospital/encounterRecords";
import { NextRequest } from "next/server";
import { EncounterStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { transitionEncounter, InvalidEncounterTransitionError } from "@/lib/hospital/encounterStateMachine";

/**
 * Structured triage (brief §13) + controlled status transitions (brief
 * §13/docs/CLINICAL_CORE.md §3). Any status change goes through
 * transitionEncounter(), which validates the transition is legal and
 * audits it — this route no longer writes `status` directly.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("encounter:triage", body?.facilityId);

    const encounter = await prisma.encounter.findUnique({ where: { id } });
    if (!encounter || encounter.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");

    const triageLevel = body?.triageLevel as number | undefined;
    const requestedStatus = body?.status as EncounterStatus | undefined;
    // Non-state-machine field updates (triageLevel, attendingStaffId) go through the service.
    await updateEncounterDetails({ encounterId: id, facilityId, triageLevel, attendingStaffId: body?.attendingStaffId });

    // Status change (triage level entry implies TRIAGED unless an explicit status was also given).
    // transitionEncounter() audits the status change itself — only log separately when there was no status change.
    const targetStatus = requestedStatus ?? (triageLevel !== undefined ? EncounterStatus.TRIAGED : undefined);
    let updated = await prisma.encounter.findUniqueOrThrow({ where: { id } });
    if (targetStatus) {
      try {
        updated = await transitionEncounter(id, targetStatus, { byUserId: session.userId });
      } catch (err) {
        if (err instanceof InvalidEncounterTransitionError) throw new BadRequestError(err.message);
        throw err;
      }
    } else {
      await recordAuditEvent(
        "hospital.encounter.updated",
        session.userId,
        { encounterId: id, triageLevel },
        { facilityId, patientId: encounter.patientId, encounterId: id }
      );
    }

    return { encounter: updated };
  });
}
