import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { recordStorageCheck } from "@/lib/hospital/pharmacy";

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("pharmacy:storage:record", body?.facilityId);
    if (!staff) throw new BadRequestError("Storage checks require a staff account.");
    if (!body?.locationId || body?.recordedValue === undefined || !body?.unit) throw new BadRequestError("locationId, recordedValue, and unit are required.");
    const check = await recordStorageCheck({ facilityId, locationId: body.locationId, recordedValue: Number(body.recordedValue), unit: body.unit, status: body.status, recordedByStaffId: staff.id, notes: body.notes, byUserId: session.userId });
    return { check };
  });
}
