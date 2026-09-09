import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { startTransfusion } from "@/lib/hospital/blood";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("blood:transfusion:record", body?.facilityId);
    if (!staff) throw new BadRequestError("Transfusion recording requires a staff account.");
    if (!body?.unitId) throw new BadRequestError("unitId is required.");
    const transfusion = await startTransfusion({
      requestId: id, facilityId, unitId: body.unitId, administeredByStaffId: staff.id,
      patientIdentityVerified: !!body.patientIdentityVerified, unitIdentityVerified: !!body.unitIdentityVerified, productVerified: !!body.productVerified,
      bloodGroupReviewed: !!body.bloodGroupReviewed, compatibilityReviewed: !!body.compatibilityReviewed, expiryReviewed: !!body.expiryReviewed,
      secondCheckStaffId: body.secondCheckStaffId, byUserId: session.userId,
    });
    return { transfusion };
  });
}
