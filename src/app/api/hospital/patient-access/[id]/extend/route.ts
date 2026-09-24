import { NextRequest } from "next/server";
import { withApiErrors, NotFoundError, BadRequestError } from "@/lib/auth/rbac";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { prisma } from "@/lib/db";
import { extendAccessSession } from "@/lib/patient/accessSession";

/**
 * POST — "Continue this session". The clinician extends an ACTIVE consult by a
 * grace window. Refused (400) if the session already timed out — at that point
 * the patient must generate a fresh code.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { session } = await requireFacilityStaff("clinical:chart:read");
    const { id } = await params;

    const found = await prisma.patientAccessSession.findUnique({ where: { id } });
    if (!found) throw new NotFoundError("Session not found.");
    if (found.doctorUserId !== session.userId) throw new NotFoundError("Session not found.");

    const extended = await extendAccessSession(id);
    if (!extended) throw new BadRequestError("This session has already timed out. Ask the patient for a new code.");

    return { ok: true, activeExpiresAt: extended.activeExpiresAt, extensionCount: extended.extensionCount };
  });
}
