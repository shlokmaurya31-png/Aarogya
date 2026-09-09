import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { reserveUnits } from "@/lib/hospital/blood";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("blood:reservation:manage", body?.facilityId);
    if (!staff) throw new BadRequestError("Reservations require a staff account.");
    if (!Array.isArray(body?.unitIds) || body.unitIds.length === 0) throw new BadRequestError("unitIds (non-empty array) is required.");
    const reservations = await reserveUnits({ requestId: id, facilityId, unitIds: body.unitIds, reservedByStaffId: staff.id, expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined, byUserId: session.userId });
    return { reservations };
  });
}
