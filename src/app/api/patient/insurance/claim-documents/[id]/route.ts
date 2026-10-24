import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { patientSession } from "@/lib/household/routeAuth";
import { attachClaimDocuments } from "@/lib/insurance/claimDocuments";

/** POST { documentIds, confirmSensitive?, memberPersonId? } — attach your uploads to the hospital's request for your claim. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const s = await patientSession();
    const body = (await req.json().catch(() => ({}))) as { documentIds?: unknown; confirmSensitive?: unknown; memberPersonId?: unknown };
    return attachClaimDocuments({ userId: s.userId, memberPersonId: typeof body.memberPersonId === "string" ? body.memberPersonId : undefined }, (await params).id, body);
  });
}
