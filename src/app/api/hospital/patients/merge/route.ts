import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { mergePatients, AlreadyMergedError, SelfMergeError, CrossFacilityMergeError } from "@/lib/patient/merge";

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { staff, facilityId } = await requireFacilityStaff("patient:merge", body?.facilityId);
    if (!staff) throw new BadRequestError("Patient merges must be performed by a staff account.");

    const { sourcePatientId, targetPatientId, reason } = body ?? {};
    if (!sourcePatientId || !targetPatientId || !reason) {
      throw new BadRequestError("sourcePatientId, targetPatientId and reason are required.");
    }

    const [source, target] = await Promise.all([
      prisma.patient.findUnique({ where: { id: sourcePatientId } }),
      prisma.patient.findUnique({ where: { id: targetPatientId } }),
    ]);
    if (!source || source.facilityId !== facilityId || !target || target.facilityId !== facilityId) {
      throw new NotFoundError("Patient not found.");
    }

    try {
      const record = await mergePatients({ sourcePatientId, targetPatientId, actorStaffId: staff.id, actorUserId: staff.userId, reason });
      return { mergeRecord: record };
    } catch (err) {
      if (err instanceof AlreadyMergedError || err instanceof SelfMergeError || err instanceof CrossFacilityMergeError) {
        throw new BadRequestError(err.message);
      }
      throw err;
    }
  });
}
