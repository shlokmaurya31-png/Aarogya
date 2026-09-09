import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { registerEdArrival } from "@/lib/hospital/emergency";

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("ed:encounter:create", body?.facilityId);
    if (!body?.patientId) throw new BadRequestError("patientId is required (search/register the patient via EMPI first).");
    // Wrong-patient/cross-facility protection: the patient must belong to the actor's facility.
    const patient = await prisma.patient.findUnique({ where: { id: body.patientId } });
    if (!patient || patient.facilityId !== facilityId) throw new NotFoundError("Patient not found.");
    const encounter = await registerEdArrival({
      facilityId, patientId: body.patientId, chiefComplaint: body.chiefComplaint, accessSource: body.accessSource, arrivalMode: body.arrivalMode,
      referringProviderName: body.referringProviderName, referringFacilityName: body.referringFacilityName, traumaIndicator: body.traumaIndicator,
      ambulanceRef: body.ambulanceRef, registeredByStaffId: staff?.id, byUserId: session.userId,
    });
    return { encounter };
  });
}
