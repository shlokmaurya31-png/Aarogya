import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { findDuplicateCandidates } from "@/lib/patient/duplicateDetection";

/**
 * Duplicate-check for a not-yet-created registration draft (brief §9) —
 * called by the registration form before submitting, so staff can review
 * candidates and decide whether to proceed or open an existing record
 * instead. Never auto-blocks registration; the caller decides.
 */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { facilityId } = await requireFacilityStaff("patient:duplicate:review", body?.facilityId);

    const { fullName, phone, dob, sex } = body ?? {};
    if (!fullName) throw new BadRequestError("fullName is required.");

    const candidates = await findDuplicateCandidates(facilityId, {
      fullName,
      phone,
      dob: dob ? new Date(dob) : undefined,
      sex,
    });

    return { candidates };
  });
}
