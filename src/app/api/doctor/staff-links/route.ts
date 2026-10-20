import { NextRequest } from "next/server";
import { ForbiddenError, requireSession, withApiErrors } from "@/lib/auth/rbac";
import { claimStaffProfile } from "@/lib/doctors/locations";

/** POST { facilityId } — the doctor claims their own staff profile at a hospital; its admin approves (Week 5a). */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const s = await requireSession();
    if (s.role !== "DOCTOR") throw new ForbiddenError("doctor:profile:manage");
    const b = await req.json().catch(() => ({}));
    return claimStaffProfile(s.userId, String(b?.facilityId ?? ""));
  });
}
