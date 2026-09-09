import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { unmergePatients, NotMergedError } from "@/lib/patient/merge";

/**
 * Reverse a logical merge (brief §10). Reuses the sensitive `patient:merge`
 * permission (already restricted to the same roles allowed to merge) — no
 * separate permission is minted for the inverse of an operation those roles
 * can already perform.
 */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { staff, facilityId } = await requireFacilityStaff("patient:merge", body?.facilityId);
    if (!staff) throw new BadRequestError("Patient unmerge must be performed by a staff account.");

    const { patientId, reason } = body ?? {};
    if (!patientId || !reason) throw new BadRequestError("patientId and reason are required.");

    const patient = await prisma.patient.findUnique({ where: { id: patientId } });
    if (!patient || patient.facilityId !== facilityId) throw new NotFoundError("Patient not found.");

    try {
      const updated = await unmergePatients({ patientId, actorStaffId: staff.id, actorUserId: staff.userId, reason });
      return { patient: updated };
    } catch (err) {
      if (err instanceof NotMergedError) throw new BadRequestError(err.message);
      throw err;
    }
  });
}
