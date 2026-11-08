import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { decidePatientReview } from "@/lib/hospital/legacyImport/review";

/** POST { decision: ACCEPT | KEEP, reason }: the hospital admin decides a re-imported patient's differing details (audited). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ reviewId: string }> }) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => ({}));
    const { session, facilityId } = await requireFacilityStaff("legacy-import:run", body?.facilityId);
    return { review: await decidePatientReview({ userId: session.userId, facilityId }, (await params).reviewId, body) };
  });
}
