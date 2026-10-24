import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { cancelClaimDocumentRequest } from "@/lib/insurance/claimDocuments";

/** DELETE — cancel an open request. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { session, facilityId } = await requireFacilityStaff("insurance:claim:review", req.nextUrl.searchParams.get("facilityId") ?? undefined);
    return cancelClaimDocumentRequest({ userId: session.userId, facilityId }, (await params).id);
  });
}
