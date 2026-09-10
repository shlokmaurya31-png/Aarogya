import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { createRca } from "@/lib/hospital/quality/service";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("quality:rca:create", body?.facilityId);
    if (!staff) throw new BadRequestError("This action requires a staff account.");
    if (!body?.problemStatement) throw new BadRequestError("problemStatement is required.");
    const rca = await createRca({
      facilityId, incidentId: id, methodology: body.methodology, problemStatement: body.problemStatement,
      contributingFactors: body.contributingFactors, rootCauses: body.rootCauses, findings: body.findings,
      recommendations: body.recommendations, authoredByStaffId: staff.id, byUserId: session.userId,
    });
    return { rca };
  });
}
