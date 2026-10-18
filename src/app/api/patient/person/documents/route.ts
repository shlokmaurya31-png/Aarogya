import { requireSession, withApiErrors, ForbiddenError } from "@/lib/auth/rbac";
import { listOwnDocuments } from "@/lib/person/documents";

/** Phase 0: your own uploads (metadata; download through ./[id]/download). */
export async function GET() {
  return withApiErrors(async () => {
    const session = await requireSession();
    if (session.role !== "PATIENT") throw new ForbiddenError("patient:self:read");
    const docs = await listOwnDocuments(session.userId);
    return { documents: docs.map((d) => ({ id: d.id, type: d.type, title: d.title, uploadedAt: d.uploadedAt.toISOString() })) };
  });
}
