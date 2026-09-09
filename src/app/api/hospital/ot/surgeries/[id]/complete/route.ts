import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { completeProcedure, SurgeryTransitionError } from "@/lib/hospital/surgery";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("ot:procedure:manage", body?.facilityId);
    if (!staff) throw new BadRequestError("Must be performed by a staff account.");
    try {
      const surgery = await completeProcedure({
        surgeryId: id, facilityId, operativeFindings: body?.operativeFindings, operativeDetails: body?.operativeDetails,
        complications: body?.complications, estimatedBloodLossMl: body?.estimatedBloodLossMl, recoveryDestination: body?.recoveryDestination, byUserId: session.userId,
      });
      return { surgery };
    } catch (err) {
      if (err instanceof SurgeryTransitionError) throw new BadRequestError(err.message);
      throw err;
    }
  });
}
