import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { patientSession } from "@/lib/household/routeAuth";
import { checkInOptions, myCheckIns, submitPreArrival } from "@/lib/insurance/checkin";

/** GET ?appointmentId=|admissionRequestId= — the check-in screen; with neither, your check-ins (Week 5c). */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const s = await patientSession();
    const q = req.nextUrl.searchParams;
    const a = { userId: s.userId, memberPersonId: q.get("memberPersonId") ?? undefined };
    if (!q.get("appointmentId") && !q.get("admissionRequestId")) return myCheckIns(a);
    return checkInOptions(a, { appointmentId: q.get("appointmentId") ?? undefined, admissionRequestId: q.get("admissionRequestId") ?? undefined });
  });
}

/** POST { appointmentId | admissionRequestId, detailsConfirmed | detailsMismatch, share?, cardId? | selfPay, memberPersonId? } */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const s = await patientSession();
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    return submitPreArrival({ userId: s.userId, memberPersonId: typeof body.memberPersonId === "string" ? body.memberPersonId : undefined }, body);
  });
}
