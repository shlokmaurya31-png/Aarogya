import { NextRequest } from "next/server";
import { requireSession, withApiErrors, ForbiddenError } from "@/lib/auth/rbac";
import { personDocumentDownload } from "@/lib/person/documents";

/** Phase 0: a short-lived signed URL for one of your own uploads. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const session = await requireSession();
    if (session.role !== "PATIENT") throw new ForbiddenError("patient:self:read");
    return personDocumentDownload({ kind: "OWNER", userId: session.userId }, id);
  });
}
