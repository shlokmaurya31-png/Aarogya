import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { ensureChecklist, updateChecklistItem } from "@/lib/hospital/surgery";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("clinical:chart:read", searchParams.get("facilityId") ?? undefined);
    const items = await ensureChecklist(id, facilityId);
    return { items };
  });
}
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("ot:checklist:record", body?.facilityId);
    if (!staff) throw new BadRequestError("Must be performed by a staff account.");
    if (!body?.itemKey || typeof body?.checked !== "boolean") throw new BadRequestError("itemKey and checked are required.");
    const item = await updateChecklistItem({ surgeryId: id, facilityId, itemKey: body.itemKey, checked: body.checked, checkedByStaffId: staff.id, byUserId: session.userId });
    return { item };
  });
}
