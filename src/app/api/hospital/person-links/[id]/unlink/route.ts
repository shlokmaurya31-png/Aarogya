import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { requestFacilityUnlink } from "@/lib/person/linking";

/** Phase 0: ask to unlink a record from a Person. Body: { reason: "WRONG_PERSON" | "SECURITY" }. A second staff member approves. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("patient:identity:unlink", body?.facilityId);
    return requestFacilityUnlink({ facilityId, linkId: id, reason: body?.reason, byUserId: session.userId });
  });
}
