import { NextRequest } from "next/server";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { prisma } from "@/lib/db";
import { endAccessSession } from "@/lib/patient/accessSession";

/**
 * POST — the clinician ends the visit. This closes the shared workflow record
 * and logs the completed visit to BOTH the doctor's and the patient's audit
 * trails (see endAccessSession).
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { session } = await requireFacilityStaff("clinical:chart:read");
    const { id } = await params;

    const accessSession = await prisma.patientAccessSession.findUnique({ where: { id } });
    if (!accessSession) throw new NotFoundError("Session not found.");
    if (accessSession.doctorUserId !== session.userId) throw new NotFoundError("Session not found.");

    const ended = await endAccessSession(id, "DOCTOR", session.userId);
    return { ok: true, status: ended?.status ?? "ENDED", endedAt: ended?.endedAt };
  });
}
