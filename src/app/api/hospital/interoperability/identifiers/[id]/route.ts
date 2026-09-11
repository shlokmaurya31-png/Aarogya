import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { unlinkExternalIdentifier, verifyExternalIdentifier } from "@/lib/hospital/interoperability/externalIdentity";

/**
 * Unlink (status transition, never a delete) or ask the registry to verify.
 *
 * Verification returns the adapter outcome verbatim, so when no registry is
 * configured the caller is told plainly that no external call was made rather
 * than being shown a verified-looking result.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const action = body?.action ?? "unlink";

    if (action === "verify") {
      const { session, facilityId } = await requireFacilityStaff("interop:identifier:verify", body?.facilityId);
      const result = await verifyExternalIdentifier({ facilityId, identifierId: id, byUserId: session.userId });
      return result;
    }

    const { session, facilityId } = await requireFacilityStaff("interop:identifier:manage", body?.facilityId);
    const identifier = await unlinkExternalIdentifier({
      facilityId, identifierId: id, status: body?.status, reason: body?.reason, byUserId: session.userId,
    });
    return { identifier };
  });
}
