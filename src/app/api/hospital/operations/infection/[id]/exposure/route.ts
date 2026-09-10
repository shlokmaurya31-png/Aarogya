import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { recordExposure } from "@/lib/hospital/operations/service";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("infection:manage", body?.facilityId);
    if (!body?.affectedPersonRef) throw new BadRequestError("affectedPersonRef is required.");
    return { exposure: await recordExposure({ incidentId: id, facilityId, affectedPersonRef: body.affectedPersonRef, locationLabel: body.locationLabel, exposureAt: body.exposureAt ? new Date(body.exposureAt) : undefined, notes: body.notes, byUserId: session.userId }) };
  });
}
