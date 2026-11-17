import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { answerCashlessQuery } from "@/lib/insurance/cashless/service";

/** POST { answer, documentIds? } — answer the insurer's question; documents added go to the patient for approval first. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const body = (await req.json().catch(() => ({}))) as { answer?: unknown; documentIds?: unknown; facilityId?: string };
    const { session, facilityId } = await requireFacilityStaff("insurance:preauth:manage", body.facilityId);
    return answerCashlessQuery({ userId: session.userId, facilityId }, (await params).id, body);
  });
}
