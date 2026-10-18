import { NextRequest } from "next/server";
import { requireSession, withApiErrors, ForbiddenError } from "@/lib/auth/rbac";
import { unlinkByPerson } from "@/lib/person/linking";

/** Phase 0: disconnect a facility record from your account, any time. Nothing clinical is deleted. */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const session = await requireSession();
    if (session.role !== "PATIENT") throw new ForbiddenError("patient:self:manage");
    return unlinkByPerson(session.userId, id);
  });
}
