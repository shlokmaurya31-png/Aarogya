import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { decideStaffLink } from "@/lib/doctors/locations";

/** POST { approve: boolean } — this facility's admin confirms (or not) that a staff profile is that doctor's (Week 5a). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { session, facilityId } = await requireFacilityStaff("hospital:admin:manage");
    const b = await req.json().catch(() => ({}));
    return decideStaffLink({ userId: session.userId, facilityId }, (await params).id, b?.approve === true);
  });
}
