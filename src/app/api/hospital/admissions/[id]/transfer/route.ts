import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { transferPatient, BedNotAvailableError } from "@/lib/hospital/admission";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("admission:transfer", body?.facilityId);

    const admission = await prisma.admission.findUnique({ where: { id }, include: { encounter: true } });
    if (!admission || admission.encounter.facilityId !== facilityId) throw new NotFoundError("Admission not found.");

    const { toBedId, reason } = body ?? {};
    if (!toBedId || !reason) throw new BadRequestError("toBedId and reason are required.");

    try {
      const transfer = await transferPatient({ admissionId: id, toBedId, reason, byUserId: session.userId });
      return { transfer };
    } catch (err) {
      if (err instanceof BedNotAvailableError) throw new BadRequestError(err.message);
      throw err;
    }
  });
}
