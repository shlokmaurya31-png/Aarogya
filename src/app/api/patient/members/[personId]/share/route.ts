import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { patientSession } from "@/lib/household/routeAuth";
import { issueCodeForMember } from "@/lib/household/proxy";

/** POST { categories?, sensitiveCategories?, period?, validHours?, patientId? } — a member's visit code, within what you can see (SHARE) (Week 5b). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ personId: string }> }) {
  return withApiErrors(async () => {
    const out = await issueCodeForMember((await patientSession()).userId, (await params).personId, await req.json().catch(() => ({})));
    return { session: { id: out.session.id, status: out.session.status, expiresAt: out.session.expiresAt }, code: out.code };
  });
}
