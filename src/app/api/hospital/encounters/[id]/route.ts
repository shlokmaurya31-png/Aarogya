import { NextRequest } from "next/server";
import { EncounterStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";

/** Structured triage (brief §13): captures level + status transition, never left to free text alone. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("encounter:triage", body?.facilityId);

    const encounter = await prisma.encounter.findUnique({ where: { id } });
    if (!encounter || encounter.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");

    const triageLevel = body?.triageLevel as number | undefined;
    const status = body?.status as EncounterStatus | undefined;
    if (triageLevel !== undefined && (triageLevel < 1 || triageLevel > 5)) {
      throw new BadRequestError("triageLevel must be between 1 (resuscitation) and 5 (non-urgent).");
    }

    const updated = await prisma.encounter.update({
      where: { id },
      data: {
        ...(triageLevel !== undefined ? { triageLevel, status: status ?? EncounterStatus.TRIAGED } : {}),
        ...(status ? { status } : {}),
        ...(body?.attendingStaffId ? { attendingStaffId: body.attendingStaffId } : {}),
      },
    });

    await recordAuditEvent("hospital.encounter.updated", session.userId, { encounterId: id, triageLevel, status });
    return { encounter: updated };
  });
}
