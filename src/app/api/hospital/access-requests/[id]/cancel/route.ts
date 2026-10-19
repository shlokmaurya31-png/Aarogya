import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { cancelRequest } from "@/lib/sharing/requests";

/** Week 4c: withdraw a request that is still waiting. */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { session, facilityId } = await requireFacilityStaff("clinical:chart:read");
    return cancelRequest({ userId: session.userId, facilityId, role: session.role }, id);
  });
}
