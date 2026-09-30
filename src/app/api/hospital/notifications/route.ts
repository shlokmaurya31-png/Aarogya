import { NextRequest } from "next/server";
import { requireHospitalStaffSelf } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { listNotifications, unreadCount } from "@/lib/hospital/notifications";

/**
 * Phase E1 — the caller's own notification stream.
 *
 * Ownership-scoped: authorization is "you can only ever read your own rows",
 * enforced by keying every query on the caller's HospitalStaffProfile id
 * (never anything from the client). A caller with no staff profile is a
 * valid authenticated user who simply owns no hospital notifications, so we
 * return an empty stream rather than an error.
 *
 * Query params:
 *   filter = "unread" | "all" (default "all")
 *   limit  = 1..100          (default 30)
 */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { staff } = await requireHospitalStaffSelf();
    if (!staff) return { items: [], unreadCount: 0 };

    const { searchParams } = new URL(req.url);
    const filter = searchParams.get("filter") === "unread" ? "unread" : "all";
    const limitRaw = Number(searchParams.get("limit"));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 30;

    const [items, unread] = await Promise.all([
      listNotifications(staff.id, { filter, limit }),
      unreadCount(staff.id),
    ]);
    return { items, unreadCount: unread };
  });
}
