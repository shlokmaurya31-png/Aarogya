import { NextRequest } from "next/server";
import { requireHospitalStaffSelf } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { markRead } from "@/lib/hospital/notifications";

/**
 * Phase E1 — mark one of the caller's own notifications read. Idempotent and
 * ownership-scoped: markRead keys on (id, recipientStaffId), so marking a row
 * you don't own simply updates nothing.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    if (!id) throw new BadRequestError("Missing notification id.");
    const { staff } = await requireHospitalStaffSelf();
    if (!staff) return { updated: 0 };
    return markRead(staff.id, id);
  });
}
