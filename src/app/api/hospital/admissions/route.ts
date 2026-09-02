import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { admitPatient, BedNotAvailableError } from "@/lib/hospital/admission";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("encounter:read", searchParams.get("facilityId") ?? undefined);

    const admissions = await prisma.admission.findMany({
      where: { encounter: { facilityId }, discharge: { is: null } },
      include: { encounter: { include: { patient: true } }, bed: { include: { ward: true } } },
      orderBy: { admittedAt: "desc" },
    });
    return { admissions };
  });
}

/** Admission per brief §9/§129: a single atomic transaction (bed + BedStateEvent + Admission row). */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("admission:create", body?.facilityId);
    if (!staff) throw new BadRequestError("Admissions must be created by a staff account.");

    const { encounterId, bedId, reason, expectedLosDays } = body ?? {};
    if (!encounterId || !bedId || !reason) throw new BadRequestError("encounterId, bedId and reason are required.");

    const encounter = await prisma.encounter.findUnique({ where: { id: encounterId } });
    if (!encounter || encounter.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");
    const bed = await prisma.bed.findUnique({ where: { id: bedId } });
    if (!bed || bed.facilityId !== facilityId) throw new NotFoundError("Bed not found.");

    try {
      const admission = await admitPatient({
        encounterId,
        bedId,
        admittingStaffId: staff.id,
        reason,
        expectedLosDays,
        byUserId: session.userId,
      });
      return { admission };
    } catch (err) {
      if (err instanceof BedNotAvailableError) throw new BadRequestError(err.message);
      throw err;
    }
  });
}
