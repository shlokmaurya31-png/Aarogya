import { ForbiddenError, requireSession, withApiErrors } from "@/lib/auth/rbac";
import { listOwnDirectoryBookings } from "@/lib/doctors/booking";

/** GET — the patient's own directory bookings (Week 5a). */
export async function GET() {
  return withApiErrors(async () => {
    const session = await requireSession();
    if (session.role !== "PATIENT") throw new ForbiddenError("patient:self:read");
    return { bookings: await listOwnDirectoryBookings(session.userId) };
  });
}
