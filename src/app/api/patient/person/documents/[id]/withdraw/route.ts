import { NextRequest } from "next/server";
import { requireSession, withApiErrors, ForbiddenError } from "@/lib/auth/rbac";
import { withdrawPersonDocument } from "@/lib/person/documents";

/** Phase 0: withdraw one of your uploads; nobody sees it after this. */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const session = await requireSession();
    if (session.role !== "PATIENT") throw new ForbiddenError("patient:self:manage");
    return withdrawPersonDocument(session.userId, id);
  });
}
