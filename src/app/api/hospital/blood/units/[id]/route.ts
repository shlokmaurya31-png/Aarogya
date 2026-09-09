import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { getUnitTraceability, releaseUnit, quarantineUnit, recallUnit, wasteUnit, recordUnitTyping } from "@/lib/hospital/blood";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("clinical:chart:read", searchParams.get("facilityId") ?? undefined);
    return { unit: await getUnitTraceability(id, facilityId) };
  });
}

/** Unit disposition actions. `action` selects the transition; all are guarded server-side. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const action = body?.action as string | undefined;
    if (!action) throw new BadRequestError("action is required.");

    if (action === "typing") {
      const { session, facilityId, staff } = await requireFacilityStaff("blood:typing:record", body?.facilityId);
      if (!staff) throw new BadRequestError("Typing must be recorded by a staff account.");
      if (!body?.aboGroup || !body?.rhStatus || !body?.verifiedByStaffId) throw new BadRequestError("aboGroup, rhStatus, and verifiedByStaffId are required.");
      const typing = await recordUnitTyping({ facilityId, unitId: id, aboGroup: body.aboGroup, rhStatus: body.rhStatus, antibodyScreen: body.antibodyScreen, performedByStaffId: staff.id, verifiedByStaffId: body.verifiedByStaffId, byUserId: session.userId });
      return { typing };
    }

    const permission = action === "release" || action === "quarantine" || action === "recall" || action === "waste" ? "blood:unit:manage" : null;
    if (!permission) throw new BadRequestError(`Unknown action: ${action}`);
    const { session, facilityId } = await requireFacilityStaff(permission, body?.facilityId);

    if (action === "release") return { unit: await releaseUnit({ unitId: id, facilityId, byUserId: session.userId }) };
    if (!body?.reason) throw new BadRequestError("reason is required.");
    if (action === "quarantine") return { unit: await quarantineUnit({ unitId: id, facilityId, reason: body.reason, byUserId: session.userId }) };
    if (action === "recall") return { unit: await recallUnit({ unitId: id, facilityId, reason: body.reason, byUserId: session.userId }) };
    return { unit: await wasteUnit({ unitId: id, facilityId, reason: body.reason, byUserId: session.userId }) };
  });
}
