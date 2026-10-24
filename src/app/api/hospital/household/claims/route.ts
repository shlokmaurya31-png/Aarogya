import { NextRequest } from "next/server";
import { BadRequestError, NotFoundError, withApiErrors } from "@/lib/auth/rbac";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { prisma } from "@/lib/db";
import { startClaimInPerson } from "@/lib/household/comingOfAge";

/**
 * POST { memberId, idType, idLast4 } — in person, for a member with no phone or email of their own:
 * the staff member checked their ID and hands over a one-time claim code (Week 5b, audited).
 */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const { session, staff, facilityId } = await requireFacilityStaff("patient:read");
    if (!staff) throw new BadRequestError("A staff profile is required.");
    const b = await req.json().catch(() => ({}));
    const m = await prisma.householdMember.findUnique({ where: { id: String(b?.memberId ?? "") }, select: { personId: true } });
    if (!m) throw new NotFoundError();
    return startClaimInPerson({ userId: session.userId, staffId: staff.id, facilityId }, m.personId, { idType: b?.idType, idLast4: b?.idLast4 });
  });
}
