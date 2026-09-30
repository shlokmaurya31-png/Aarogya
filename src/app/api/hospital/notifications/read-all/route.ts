import { NextRequest } from "next/server";
import { requireHospitalStaffSelf } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { markAllRead } from "@/lib/hospital/notifications";

/**
 * Phase E1 — mark ALL of the caller's own unread notifications read.
 * Idempotent and ownership-scoped.
 */
export async function POST(_req: NextRequest) {
  return withApiErrors(async () => {
    const { staff } = await requireHospitalStaffSelf();
    if (!staff) return { updated: 0 };
    return markAllRead(staff.id);
  });
}
