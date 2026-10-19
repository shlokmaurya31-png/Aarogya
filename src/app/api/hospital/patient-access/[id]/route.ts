import { NextRequest } from "next/server";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { prisma } from "@/lib/db";
import { enforceActiveExpiry } from "@/lib/patient/accessSession";
import { viewSharedRecord } from "@/lib/sharing/view";

/** A 410 Gone — the session existed but its consent window has lapsed. */
class SessionExpiredError extends Error {
  status = 410 as const;
  constructor() {
    super("This access session has expired. Ask the patient to generate a new code.");
  }
}

/**
 * GET — the shared record for an ACTIVE access session (Week 4c): only what the
 * patient's code shares (docs/CONSENT_SHARING_DESIGN.md §8), for the clinician
 * who redeemed it, while the consult is open. The first opening is written to
 * the person's access log.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { session, facilityId } = await requireFacilityStaff("clinical:chart:read");
    const { id } = await params;

    const found = await prisma.patientAccessSession.findUnique({ where: { id } });
    if (!found) throw new NotFoundError("Session not found.");
    // Only the clinician who redeemed it may read through it.
    if (found.doctorUserId !== session.userId) throw new NotFoundError("Session not found.");

    // Auto-log-off if the consult window lapsed, then gate on the live status.
    const accessSession = await enforceActiveExpiry(found);
    if (accessSession.status !== "ACTIVE") throw new SessionExpiredError();

    const { history } = await viewSharedRecord({ userId: session.userId, facilityId, role: session.role }, accessSession.id, "CONSULT_VIEW");

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
