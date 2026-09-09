import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { recordQc, listQc } from "@/lib/hospital/diagnosticsAdvanced";
import type { LabQcReviewStatus } from "@prisma/client";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("lab:qc:manage", searchParams.get("facilityId") ?? undefined);
    const status = searchParams.get("status") as LabQcReviewStatus | null;
    return { qc: await listQc(facilityId, status ?? undefined) };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("lab:qc:manage", body?.facilityId);
    if (!staff) throw new BadRequestError("QC recording requires a lab staff account.");
    if (!body?.instrumentId || !body?.controlType) throw new BadRequestError("instrumentId and controlType are required.");
    const qc = await recordQc({
      facilityId, instrumentId: body.instrumentId, controlType: body.controlType, catalogTestId: body.catalogTestId, controlLot: body.controlLot,
      observedValue: body.observedValue != null ? Number(body.observedValue) : undefined, expectedValue: body.expectedValue != null ? Number(body.expectedValue) : undefined,
      unit: body.unit, result: body.result, performedByStaffId: staff.id, notes: body.notes, byUserId: session.userId,
    });
    return { qc };
  });
}
