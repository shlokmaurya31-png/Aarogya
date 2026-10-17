import { NextRequest } from "next/server";
import { requireSession, withApiErrors, ForbiddenError } from "@/lib/auth/rbac";
import { confirmPendingLink } from "@/lib/person/linking";

/** Phase 0: "Connect your record at …?" — the person confirms a verified pending connection. */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const session = await requireSession();
    if (session.role !== "PATIENT") throw new ForbiddenError("patient:self:manage");
    return confirmPendingLink(session.userId, id);
  });
}
