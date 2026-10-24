import { NextRequest } from "next/server";
import { BadRequestError, withApiErrors } from "@/lib/auth/rbac";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { staffInPersonCheckByMember } from "@/lib/household/dependentConsent";

/**
 * POST { memberId } — a staff member records that they checked, in person, that a dependent adult
 * consents to their proxy; a second, different staff member of this facility confirms (Week 5b).
 * The reference comes from the family's screen, with the adult present.
 */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const { session, staff, facilityId } = await requireFacilityStaff("patient:read");
    if (!staff) throw new BadRequestError("A staff profile is required.");
    const b = await req.json().catch(() => ({}));
    return staffInPersonCheckByMember({ userId: session.userId, staffId: staff.id, facilityId }, String(b?.memberId ?? ""));
  });
}
