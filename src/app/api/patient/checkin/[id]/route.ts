import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { patientSession } from "@/lib/household/routeAuth";
import { cancelPreArrival } from "@/lib/insurance/checkin";

/** DELETE — cancel your check-in (its shares end). */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => cancelPreArrival({ userId: (await patientSession()).userId, memberPersonId: req.nextUrl.searchParams.get("memberPersonId") ?? undefined }, (await params).id));
}
