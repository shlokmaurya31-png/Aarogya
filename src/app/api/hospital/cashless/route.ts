import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { deskCashlessQueue, startCashlessRequest } from "@/lib/insurance/cashless/service";

/** GET — the facility's cashless requests (Flagship 5, mock NHCX): open first, then decided. */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { session, facilityId } = await requireFacilityStaff("insurance:preauth:manage", req.nextUrl.searchParams.get("facilityId") ?? undefined);
    return deskCashlessQueue({ userId: session.userId, facilityId });
  });
}

/** POST { encounterId, plannedProcedure, estimateMinor, documentIds, diagnosis?, coverageId? } — a pre-authorisation from the admission; the patient approves the documents before anything is sent. */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = (await req.json().catch(() => ({}))) as { encounterId?: unknown; coverageId?: unknown; diagnosis?: unknown; plannedProcedure?: unknown; estimateMinor?: unknown; documentIds?: unknown; facilityId?: string };
    const { session, facilityId } = await requireFacilityStaff("insurance:preauth:manage", body.facilityId);
    return startCashlessRequest({ userId: session.userId, facilityId }, body);
  });
}
