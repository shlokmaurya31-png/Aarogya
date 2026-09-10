import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { createMaintenanceRequest } from "@/lib/hospital/operations/service";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("operations:command:view", searchParams.get("facilityId") ?? undefined);
    const status = searchParams.get("status");
    const requests = await prisma.maintenanceRequest.findMany({ where: { facilityId, ...(status ? { status } : {}) }, orderBy: [{ priority: "desc" }, { reportedAt: "asc" }], take: 200 });
    return { requests };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("maintenance:request:create", body?.facilityId);
    if (!staff) throw new BadRequestError("Maintenance requests require a staff account.");
    if (!body?.issueType || !body?.description) throw new BadRequestError("issueType and description are required.");
    const request = await createMaintenanceRequest({ facilityId, issueType: body.issueType, description: body.description, locationLabel: body.locationLabel, wardId: body.wardId, equipmentId: body.equipmentId, priority: body.priority, requestedByStaffId: staff.id, byUserId: session.userId });
    return { request };
  });
}
