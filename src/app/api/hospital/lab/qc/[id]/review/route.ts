import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { reviewQc } from "@/lib/hospital/diagnosticsAdvanced";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("lab:qc:manage", body?.facilityId);
    if (!staff) throw new BadRequestError("QC review requires a lab staff account.");
    if (body?.to !== "REVIEWED" && body?.to !== "REJECTED") throw new BadRequestError("to must be REVIEWED or REJECTED.");
    const qc = await reviewQc({ qcId: id, facilityId, to: body.to, reviewedByStaffId: staff.id, notes: body.notes, byUserId: session.userId });
    return { qc };
  });
}
