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
    if (triageLevel !== undefined && (triageLevel < 1 || triageLevel > 5)) {
      throw new BadRequestError("triageLevel must be between 1 (resuscitation) and 5 (non-urgent).");
    }

    // Non-state-machine field updates (triageLevel, attendingStaffId) apply directly.
    if (triageLevel !== undefined || body?.attendingStaffId) {
      await prisma.encounter.update({
        where: { id },
        data: {
          ...(triageLevel !== undefined ? { triageLevel } : {}),
          ...(body?.attendingStaffId ? { attendingStaffId: body.attendingStaffId } : {}),
        },
      });
    }

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
      await recordAuditEvent("hospital.encounter.updated", session.userId, { encounterId: id, triageLevel });
    }

    return { encounter: updated };
  });
}
