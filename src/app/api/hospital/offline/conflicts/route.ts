import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requireNurse } from "@/lib/hospital/offline/actor";
import { conflictQueue } from "@/lib/hospital/offline/queue";

/** GET: the conflict queue of the wards the caller is the charge nurse of now (Flagship 4b). */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => conflictQueue(await requireNurse(req.nextUrl.searchParams.get("facilityId") ?? undefined)));
}
