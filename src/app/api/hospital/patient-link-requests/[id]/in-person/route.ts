import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, ForbiddenError } from "@/lib/auth/rbac";
import { startInPersonVerification } from "@/lib/person/linking";

/**
 * Phase 0: staff member A checked a government ID in person. Body: { idType,
 * idLast4, reason }. Only the last 4 characters are accepted (a full number is
 * refused). A different staff member must approve, then the person confirms.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, staff, facilityId } = await requireFacilityStaff("patient:identity:verify", body?.facilityId);
    if (!staff) throw new ForbiddenError("patient:identity:verify");
    return startInPersonVerification({ facilityId, requestId: id, staffId: staff.id, byUserId: session.userId, idType: body?.idType, idLast4: body?.idLast4, reason: body?.reason });
  });
}
