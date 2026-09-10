import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { selectQuotation } from "@/lib/hospital/procurement/procurementAdvanced";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("procurement:rfq:manage", body?.facilityId);
    return { quotation: await selectQuotation({ quotationId: id, facilityId, byUserId: session.userId }) };
  });
}
