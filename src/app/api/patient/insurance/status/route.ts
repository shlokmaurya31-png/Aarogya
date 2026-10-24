import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { patientSession } from "@/lib/household/routeAuth";
import { insuranceStatus } from "@/lib/insurance/status";

/** GET — pre-authorization, cashless, itemised bills, your share and claims, in plain words (Week 5c). */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => insuranceStatus({ userId: (await patientSession()).userId, memberPersonId: req.nextUrl.searchParams.get("memberPersonId") ?? undefined }));
}
