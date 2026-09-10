import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { transitionRfq } from "@/lib/hospital/procurement/procurementAdvanced";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("procurement:rfq:manage", body?.facilityId);
    if (!body?.to) throw new BadRequestError("to (target status) is required.");
    return { rfq: await transitionRfq({ rfqId: id, facilityId, to: body.to, byUserId: session.userId }) };
  });
}
