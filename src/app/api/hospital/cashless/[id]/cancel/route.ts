import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { cancelCashlessRequest } from "@/lib/insurance/cashless/service";

/** POST — withdraw a cashless request that hasn't been decided. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const body = (await req.json().catch(() => ({}))) as { facilityId?: string };
    const { session, facilityId } = await requireFacilityStaff("insurance:preauth:manage", body.facilityId);
    return cancelCashlessRequest({ userId: session.userId, facilityId }, (await params).id);
  });
}
