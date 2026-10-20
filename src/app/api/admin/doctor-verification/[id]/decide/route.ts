import { NextRequest } from "next/server";
import { requirePermission, withApiErrors } from "@/lib/auth/rbac";
import { decideVerification } from "@/lib/doctors/verification";

/** POST { decision: APPROVE | REJECT | ASK_MORE, reasonCode?, registrationYear? } — after the check against the register (Week 5a). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const s = await requirePermission("doctor:verify");
    return decideVerification(s.userId, (await params).id, await req.json().catch(() => ({})));
  });
}
