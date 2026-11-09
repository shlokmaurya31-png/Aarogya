import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { patientSession } from "@/lib/household/routeAuth";
import { patientCashless } from "@/lib/insurance/cashless/service";

/** GET ?memberPersonId — your (or a member's, with INSURANCE) cashless requests: documents to approve, and the insurer's decision in plain words. */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => patientCashless({ userId: (await patientSession()).userId, memberPersonId: req.nextUrl.searchParams.get("memberPersonId") ?? undefined }));
}
