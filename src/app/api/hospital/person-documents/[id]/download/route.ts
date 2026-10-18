import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { personDocumentDownload } from "@/lib/person/documents";

/**
 * Phase 0: a short-lived signed URL for a patient's upload, about one record
 * (?patientId=) of this facility — only when personAccess allows it (the
 * person's sharing choice and a care relationship, or a pre-Phase-0 upload to
 * this record before the person chose). Audited, and shown in the person's
 * access log. Otherwise 404.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { session, facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);
    const patientId = searchParams.get("patientId");
    if (!patientId) throw new BadRequestError("patientId is required.");
    return personDocumentDownload({ kind: "STAFF", userId: session.userId, facilityId, patientId }, id);
  });
}
