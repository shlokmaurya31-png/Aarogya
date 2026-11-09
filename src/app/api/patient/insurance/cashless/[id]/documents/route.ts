import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { patientSession } from "@/lib/household/routeAuth";
import { decideCashlessDocuments } from "@/lib/insurance/cashless/service";

/** POST { decisions: [{ documentId, decision: APPROVE | REMOVE }], confirmSensitive?, memberPersonId? } — only approved documents go to the insurer. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const s = await patientSession();
    const body = (await req.json().catch(() => ({}))) as { decisions?: unknown; confirmSensitive?: unknown; memberPersonId?: unknown };
    return decideCashlessDocuments({ userId: s.userId, memberPersonId: typeof body.memberPersonId === "string" ? body.memberPersonId : undefined }, (await params).id, body);
  });
}
