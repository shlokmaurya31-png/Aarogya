import { NextRequest } from "next/server";
import { ForbiddenError, requireSession, withApiErrors } from "@/lib/auth/rbac";
import { cancelOwnDirectoryBooking } from "@/lib/doctors/booking";

/** POST — the patient cancels a directory booking; its share ends with it (Week 5a). */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const session = await requireSession();
    if (session.role !== "PATIENT") throw new ForbiddenError("patient:self:manage");
    return cancelOwnDirectoryBooking(session.userId, (await params).id);
  });
}
