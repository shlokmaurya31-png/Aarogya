import { NextRequest } from "next/server";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { prisma } from "@/lib/db";
import { getSessionHistory, enforceActiveExpiry } from "@/lib/patient/accessSession";

/** A 410 Gone — the session existed but its consent window has lapsed. */
class SessionExpiredError extends Error {
  status = 410 as const;
  constructor() {
    super("This access session has expired. Ask the patient to generate a new code.");
  }
}

/**
 * GET — the full patient history for an ACTIVE access session. Access is gated
 * by the session (the patient's code IS the consent) and by the session
 * belonging to THIS clinician — not by facility scoping.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { session } = await requireFacilityStaff("clinical:chart:read");
    const { id } = await params;

    const found = await prisma.patientAccessSession.findUnique({ where: { id } });
    if (!found) throw new NotFoundError("Session not found.");
    // Only the clinician who redeemed it may read through it.
    if (found.doctorUserId !== session.userId) throw new NotFoundError("Session not found.");

    // Auto-log-off if the consult window lapsed, then gate on the live status.
    const accessSession = await enforceActiveExpiry(found);
    if (accessSession.status !== "ACTIVE") throw new SessionExpiredError();

    const history = await getSessionHistory(accessSession.patientId);
    if (!history) throw new NotFoundError("Patient not found.");

    return {
      session: {
        id: accessSession.id,
        status: accessSession.status,
        redeemedAt: accessSession.redeemedAt,
        doctorName: accessSession.doctorName,
        activeExpiresAt: accessSession.activeExpiresAt,
        extensionCount: accessSession.extensionCount,
      },
      ...history,
    };
  });
}
