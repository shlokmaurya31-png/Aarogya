import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { patientSession } from "@/lib/household/routeAuth";
import { orderStatus } from "@/lib/insurance/hospitalPayments";

/** GET — a payment order's status (PAID only once the hospital's gateway confirmed it). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => orderStatus({ userId: (await patientSession()).userId, memberPersonId: req.nextUrl.searchParams.get("memberPersonId") ?? undefined }, (await params).id));
}
