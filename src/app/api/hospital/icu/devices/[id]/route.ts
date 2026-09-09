import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { updateDeviceStatus, DeviceStatusError } from "@/lib/hospital/icu";

/** Device lifecycle transition (PLANNED -> ACTIVE -> REMOVED/DISCONTINUED). */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("icu:device:manage", body?.facilityId);
    if (!body?.status) throw new BadRequestError("status is required.");

    try {
      const device = await updateDeviceStatus({
        deviceId: id,
        facilityId,
        status: body.status,
        removedAt: body.removedAt ? new Date(body.removedAt) : undefined,
        notes: body.notes,
        byUserId: session.userId,
      });
      return { device };
    } catch (err) {
      if (err instanceof DeviceStatusError) throw new BadRequestError(err.message);
      throw err;
    }
  });
}
