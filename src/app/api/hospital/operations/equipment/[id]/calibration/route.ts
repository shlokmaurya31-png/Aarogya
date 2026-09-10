import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { recordEquipmentCalibration, recordEquipmentMaintenance } from "@/lib/hospital/operations/service";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("biomedical:calibration:manage", body?.facilityId);
    if (!staff) throw new BadRequestError("Requires a staff account.");
    if (body?.kind === "maintenance") {
      if (!body?.maintenanceType) throw new BadRequestError("maintenanceType is required.");
      return { record: await recordEquipmentMaintenance({ equipmentId: id, facilityId, maintenanceType: body.maintenanceType, performedByStaffId: staff.id, result: body.result, notes: body.notes, byUserId: session.userId }) };
    }
    return { record: await recordEquipmentCalibration({ equipmentId: id, facilityId, performedByStaffId: staff.id, result: body?.result, certificateRef: body?.certificateRef, nextDueAt: body?.nextDueAt ? new Date(body.nextDueAt) : undefined, byUserId: session.userId }) };
  });
}
