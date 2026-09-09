import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { recordCalibration, listCalibration } from "@/lib/hospital/diagnosticsAdvanced";
import type { LabQcReviewStatus } from "@prisma/client";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("lab:calibration:manage", searchParams.get("facilityId") ?? undefined);
    const status = searchParams.get("status") as LabQcReviewStatus | null;
    return { calibrations: await listCalibration(facilityId, status ?? undefined) };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("lab:calibration:manage", body?.facilityId);
    if (!staff) throw new BadRequestError("Calibration recording requires a lab staff account.");
    if (!body?.instrumentId || !body?.calibrationType) throw new BadRequestError("instrumentId and calibrationType are required.");
    const calibration = await recordCalibration({
      facilityId, instrumentId: body.instrumentId, calibrationType: body.calibrationType, performedByStaffId: staff.id,
      nextDueAt: body.nextDueAt ? new Date(body.nextDueAt) : undefined, notes: body.notes, byUserId: session.userId,
    });
    return { calibration };
  });
}
