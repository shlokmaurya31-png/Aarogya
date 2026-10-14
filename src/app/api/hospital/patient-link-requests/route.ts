import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { listLinkRequests } from "@/lib/patient/selfRegistration";

/** Front desk: self-registered accounts that likely match an existing record, awaiting a decision. */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:duplicate:review", searchParams.get("facilityId") ?? undefined);
    return { requests: await listLinkRequests(facilityId) };
  });
}
