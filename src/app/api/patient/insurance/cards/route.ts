import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { patientSession } from "@/lib/household/routeAuth";
import { addCard, listCards } from "@/lib/insurance/cards";

/** Week 5c — your insurance cards, or a member's (?memberPersonId=, a proxy with INSURANCE). Numbers masked. */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => listCards({ userId: (await patientSession()).userId, memberPersonId: req.nextUrl.searchParams.get("memberPersonId") ?? undefined }));
}

/** POST { payerType, scheme?, payerId?, payerName?, planName?, memberId, policyNumber?, validFrom?, validTo?, memberPersonId? } */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const s = await patientSession();
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    return addCard({ userId: s.userId, memberPersonId: typeof body.memberPersonId === "string" ? body.memberPersonId : undefined }, body);
  });
}
