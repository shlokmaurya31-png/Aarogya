import { NextRequest } from "next/server";
import { requireSession, withApiErrors, ForbiddenError } from "@/lib/auth/rbac";
import { listOwnNotifications } from "@/lib/person/notifications";

/** GET — the person's own notifications about access to their record (4c answers): newest first. */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const session = await requireSession();
    if (session.role !== "PATIENT") throw new ForbiddenError("patient:self:read");
    const limit = Number(new URL(req.url).searchParams.get("limit") ?? 30);
    return { notifications: await listOwnNotifications(session.userId, Number.isFinite(limit) ? limit : 30) };
  });
}
