import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { patientSession } from "@/lib/household/routeAuth";
import { bulkReview, factsPage } from "@/lib/documents/review";

/**
 * GET — a member's facts awaiting review (UPLOAD), in pages (?cursor=, Flagship 3c).
 * POST { decisions } — decide them (labelled confirmed by proxy) (Week 5b).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ personId: string }> }) {
  return withApiErrors(async () => factsPage((await patientSession()).userId, (await params).personId, { cursor: req.nextUrl.searchParams.get("cursor") }));
}
export async function POST(req: NextRequest, { params }: { params: Promise<{ personId: string }> }) {
  return withApiErrors(async () => {
    const b = await req.json().catch(() => ({}));
    return bulkReview((await patientSession()).userId, { decisions: b?.decisions, memberPersonId: (await params).personId });
  });
}
