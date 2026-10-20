import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { personDocumentDownload } from "@/lib/person/documents";

/**
 * GET — a 5-minute signed URL for one of the patient's uploads, through a
 * share (Week 4c fix, docs/CONSENT_SHARING_DESIGN.md §15). `id` is what the
 * doctor holds: a visit code's session id or an approved request's share id.
 * The share is resolved first (live, theirs, with UPLOADS) and the document
 * must be one the share shows; then the read is audited and written to the
 * person's access log. Anything else is a 404.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string; documentId: string }> }) {
  return withApiErrors(async () => {
    const { session, facilityId } = await requireFacilityStaff("clinical:chart:read");
    const { id, documentId } = await params;
    return personDocumentDownload({ kind: "SHARE", userId: session.userId, facilityId, role: session.role, shareRef: id }, documentId);
  });
}
