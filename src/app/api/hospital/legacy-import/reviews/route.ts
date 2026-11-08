import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { BadRequestError, withApiErrors } from "@/lib/auth/rbac";
import { listPatientReviews } from "@/lib/hospital/legacyImport/review";

const STATUSES = ["OPEN", "ACCEPTED", "KEPT"] as const;

/** GET ?status=: re-imported patients whose details differ, waiting for the hospital admin (Flagship 3d). */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const q = req.nextUrl.searchParams;
    const { facilityId } = await requireFacilityStaff("legacy-import:run", q.get("facilityId") ?? undefined);
    const status = q.get("status") ?? "OPEN";
    if (!(STATUSES as readonly string[]).includes(status)) throw new BadRequestError(`status must be one of ${STATUSES.join(", ")}.`);
    return { reviews: await listPatientReviews(facilityId, { status: status as (typeof STATUSES)[number] }) };
  });
}
