import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { createHousekeepingRequest } from "@/lib/hospital/operations/service";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("operations:command:view", searchParams.get("facilityId") ?? undefined);
    const status = searchParams.get("status");
    const requests = await prisma.housekeepingRequest.findMany({ where: { facilityId, ...(status ? { status } : {}) }, orderBy: [{ priority: "desc" }, { requestedAt: "asc" }], take: 200 });
    return { requests };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("housekeeping:request:create", body?.facilityId);
    if (!staff) throw new BadRequestError("Requests require a staff account.");
    if (!body?.requestType) throw new BadRequestError("requestType is required.");
    const request = await createHousekeepingRequest({ facilityId, requestType: body.requestType, bedId: body.bedId, wardId: body.wardId, areaLabel: body.areaLabel, priority: body.priority, reason: body.reason, isDischargeCleaning: body.isDischargeCleaning, encounterId: body.encounterId, requestedByStaffId: staff.id, byUserId: session.userId });
    return { request };
  });
}
