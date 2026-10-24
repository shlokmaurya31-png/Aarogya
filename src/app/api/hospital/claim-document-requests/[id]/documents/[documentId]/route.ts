import { NextRequest } from "next/server";
import { NotFoundError, withApiErrors } from "@/lib/auth/rbac";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { prisma } from "@/lib/db";
import { personDocumentDownload } from "@/lib/person/documents";

/** GET — a 5-minute URL for one document the patient attached to a claim request, through its CLAIM share (Week 5c). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; documentId: string }> }) {
  return withApiErrors(async () => {
    const { session, facilityId } = await requireFacilityStaff("insurance:claim:review", req.nextUrl.searchParams.get("facilityId") ?? undefined);
    const { id, documentId } = await params;
    const r = await prisma.claimDocumentRequest.findUnique({ where: { id }, select: { facilityId: true, shareId: true } });
    if (!r || r.facilityId !== facilityId || !r.shareId) throw new NotFoundError();
    return personDocumentDownload({ kind: "SHARE", userId: session.userId, facilityId, role: session.role, shareRef: r.shareId }, documentId);
  });
}
