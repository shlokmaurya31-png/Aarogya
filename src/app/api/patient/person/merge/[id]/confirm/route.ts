import { NextRequest } from "next/server";
import { requireSession, withApiErrors, ForbiddenError } from "@/lib/auth/rbac";
import { confirmPersonMerge } from "@/lib/person/merge";

/** Phase 0: body { thisAccountCode, otherAccountCode } — the codes sent to each account's email. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const session = await requireSession();
    if (session.role !== "PATIENT") throw new ForbiddenError("patient:self:manage");
    const b = await req.json().catch(() => null);
    return confirmPersonMerge(session.userId, id, { thisAccountCode: String(b?.thisAccountCode ?? ""), otherAccountCode: String(b?.otherAccountCode ?? "") });
  });
}
