import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { checkEligibilityAtCheckIn } from "@/lib/insurance/cashless/service";

/** POST — check the card shared at this check-in through the exchange (mock NHCX); eligible verifies it into coverage. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const body = (await req.json().catch(() => ({}))) as { facilityId?: string };
    const { session, facilityId } = await requireFacilityStaff("insurance:coverage:manage", body.facilityId);
    return checkEligibilityAtCheckIn({ userId: session.userId, facilityId }, (await params).id);
  });
}
