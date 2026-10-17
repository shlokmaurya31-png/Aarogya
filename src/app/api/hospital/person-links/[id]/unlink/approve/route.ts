import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { approveFacilityUnlink } from "@/lib/person/linking";

/** Phase 0: a second, different staff member approves the unlink; the person is notified. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("patient:identity:unlink", body?.facilityId);
    return approveFacilityUnlink({ facilityId, linkId: id, byUserId: session.userId });
  });
}
