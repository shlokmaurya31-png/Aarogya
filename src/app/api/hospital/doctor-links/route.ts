import { withApiErrors } from "@/lib/auth/rbac";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { pendingStaffLinks } from "@/lib/doctors/locations";

/** GET — doctors waiting for this facility's admin to confirm their staff profile (Week 5a). */
export async function GET() {
  return withApiErrors(async () => {
    const { facilityId } = await requireFacilityStaff("hospital:admin:manage");
    return { links: await pendingStaffLinks(facilityId) };
  });
}
