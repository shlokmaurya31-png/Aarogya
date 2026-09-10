import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { createInfectionIncident } from "@/lib/hospital/operations/service";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("operations:command:view", searchParams.get("facilityId") ?? undefined);
    const status = searchParams.get("status");
    const incidents = await prisma.infectionIncident.findMany({ where: { facilityId, ...(status ? { status } : {}) }, orderBy: { reportedAt: "desc" }, take: 200 });
    return { incidents };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("infection:incident:create", body?.facilityId);
    if (!staff) throw new BadRequestError("Reporting requires a staff account.");
    if (!body?.incidentType) throw new BadRequestError("incidentType is required.");
    const incident = await createInfectionIncident({ facilityId, incidentType: body.incidentType, patientId: body.patientId, encounterId: body.encounterId, wardId: body.wardId, locationLabel: body.locationLabel, onsetAt: body.onsetAt ? new Date(body.onsetAt) : undefined, isolationRequired: body.isolationRequired, reportedByStaffId: staff.id, notes: body.notes, byUserId: session.userId });
    return { incident };
  });
}
