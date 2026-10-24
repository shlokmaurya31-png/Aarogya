import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { claimDocumentRequests, requestClaimDocuments } from "@/lib/insurance/claimDocuments";

/** GET — the claim's document requests and the documents the patient attached (Week 5c). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { facilityId } = await requireFacilityStaff("insurance:claim:review", req.nextUrl.searchParams.get("facilityId") ?? undefined);
    return claimDocumentRequests({ facilityId }, (await params).id);
  });
}

/** POST { description } — ask the patient for a document (they attach their uploads; they never answer the insurer). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const body = (await req.json().catch(() => ({}))) as { description?: unknown; facilityId?: string };
    const { session, facilityId } = await requireFacilityStaff("insurance:claim:review", body.facilityId);
    return requestClaimDocuments({ userId: session.userId, facilityId }, (await params).id, body.description);
  });
}
