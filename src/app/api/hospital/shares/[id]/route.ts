import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { viewSharedRecord } from "@/lib/sharing/view";

/**
 * GET — a record shared through an approved access request (Week 4c,
 * docs/CONSENT_SHARING_DESIGN.md §5, §8): only to its recipient doctor, or a
 * doctor of its recipient facility who treats the person, while it lasts.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { session, facilityId } = await requireFacilityStaff("clinical:chart:read");
    const { id } = await params;
    const { scope, history } = await viewSharedRecord({ userId: session.userId, facilityId, role: session.role }, id, "SHARED_RECORD_VIEW");
    return { share: { id: scope.shareId, expiresAt: scope.expiresAt?.toISOString() ?? null }, ...history };
  });
}
