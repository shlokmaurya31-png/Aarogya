import { NextRequest } from "next/server";
import { NotFoundError, withApiErrors } from "@/lib/auth/rbac";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { prisma } from "@/lib/db";
import { cardPhotoUrl, staffCard } from "@/lib/insurance/cards";

/** GET [?photo=FRONT|BACK] — the check-in's insurance card, through its card share (logged in the patient's access log). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const q = req.nextUrl.searchParams;
    const { session, facilityId } = await requireFacilityStaff("insurance:coverage:manage", q.get("facilityId") ?? undefined);
    const ci = await prisma.preArrivalCheckIn.findUnique({ where: { id: (await params).id }, select: { facilityId: true, cardShareId: true } });
    if (!ci || ci.facilityId !== facilityId || !ci.cardShareId) throw new NotFoundError();
    const actor = { userId: session.userId, facilityId, cardShareId: ci.cardShareId };
    const photo = q.get("photo");
    if (photo === "FRONT" || photo === "BACK") {
      const { card } = await staffCard(actor);
      return cardPhotoUrl({ kind: "CARD_SHARE", ...actor }, card.id, photo);
    }
    return (await staffCard(actor)).view;
  });
}
