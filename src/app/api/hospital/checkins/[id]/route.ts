import { NextRequest } from "next/server";
import { BadRequestError, withApiErrors } from "@/lib/auth/rbac";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { deskDecide, markArrived } from "@/lib/insurance/checkin";
import { verifyCheckInCard } from "@/lib/insurance/cardShares";

/**
 * PATCH { action: "READY" | "NEEDS_DESK" (reason) | "ARRIVED" | "VERIFY_CARD" (outcome, payerId?, planId?) } (Week 5c).
 * Card verification needs insurance:coverage:manage; the rest queue:manage.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const { id } = await params;
    if (body.action === "VERIFY_CARD") {
      const { session, facilityId } = await requireFacilityStaff("insurance:coverage:manage", body.facilityId as string | undefined);
      return verifyCheckInCard({ userId: session.userId, facilityId }, id, body);
    }
    const { session, facilityId, staff } = await requireFacilityStaff("queue:manage", body.facilityId as string | undefined);
    if (body.action === "ARRIVED") return markArrived({ userId: session.userId, facilityId, staffId: staff?.id }, id);
    if (body.action === "READY" || body.action === "NEEDS_DESK") return deskDecide({ userId: session.userId, facilityId }, id, { status: body.action, reason: body.reason });
    throw new BadRequestError("action must be READY, NEEDS_DESK, ARRIVED or VERIFY_CARD.");
  });
}
