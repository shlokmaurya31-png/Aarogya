import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, ForbiddenError } from "@/lib/auth/rbac";
import { approveInPersonVerification } from "@/lib/person/linking";

/** Phase 0: a second, different staff member approves an in-person ID verification. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, staff, facilityId } = await requireFacilityStaff("patient:identity:verify", body?.facilityId);
    if (!staff) throw new ForbiddenError("patient:identity:verify");
    return approveInPersonVerification({ facilityId, linkId: id, staffId: staff.id, byUserId: session.userId });
  });
}
