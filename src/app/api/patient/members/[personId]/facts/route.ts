import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { patientSession } from "@/lib/household/routeAuth";
import { bulkReview, listFactsFor } from "@/lib/documents/review";

/** GET — a member's facts awaiting review (UPLOAD). POST { decisions } — decide them (labelled confirmed by proxy) (Week 5b). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ personId: string }> }) {
  return withApiErrors(async () => ({ facts: await listFactsFor((await patientSession()).userId, (await params).personId) }));
}
export async function POST(req: NextRequest, { params }: { params: Promise<{ personId: string }> }) {
  return withApiErrors(async () => {
    const b = await req.json().catch(() => ({}));
    return bulkReview((await patientSession()).userId, { decisions: b?.decisions, memberPersonId: (await params).personId });
  });
}
