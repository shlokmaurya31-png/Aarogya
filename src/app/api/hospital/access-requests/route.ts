import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { listFacilityRequests, requestAccess } from "@/lib/sharing/requests";

/**
 * Week 4c — access requests (docs/CONSENT_SHARING_DESIGN.md §5).
 * POST { patientId, requesterKind: "DOCTOR" | "FACILITY", purpose, categories, period?, reason? }:
 * ask the person for a share of their record (only about a patient of this facility linked to an account).
 * GET ?patientId= — this facility's requests (a doctor: their own).
 */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const { session, facilityId } = await requireFacilityStaff("clinical:chart:read");
    return requestAccess({ userId: session.userId, facilityId, role: session.role }, await req.json().catch(() => null));
  });
}

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { session, facilityId } = await requireFacilityStaff("clinical:chart:read");
    return { requests: await listFacilityRequests({ userId: session.userId, facilityId, role: session.role }, req.nextUrl.searchParams.get("patientId") ?? undefined) };
  });
}
