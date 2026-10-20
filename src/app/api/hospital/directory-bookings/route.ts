import { withApiErrors } from "@/lib/auth/rbac";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { doctorSharedBookings } from "@/lib/doctors/booking";

/** GET — this doctor's directory bookings here that carry a record share (Week 5a). */
export async function GET() {
  return withApiErrors(async () => {
    const { session, facilityId } = await requireFacilityStaff("clinical:chart:read");
    return { bookings: await doctorSharedBookings(session.userId, facilityId) };
  });
}
