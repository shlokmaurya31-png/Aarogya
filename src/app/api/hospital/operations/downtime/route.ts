import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { startDowntime } from "@/lib/hospital/operations/service";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("operations:command:view", searchParams.get("facilityId") ?? undefined);
    const items = await prisma.assetDowntime.findMany({ where: { facilityId, status: "ACTIVE" }, orderBy: { startedAt: "desc" }, take: 200 });
    return { items };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("maintenance:manage", body?.facilityId);
    if (!staff) throw new BadRequestError("Requires a staff account.");
    if (!body?.reason) throw new BadRequestError("reason is required.");
    const item = await startDowntime({ facilityId, reason: body.reason, equipmentId: body.equipmentId, assetLabel: body.assetLabel, locationLabel: body.locationLabel, byStaffId: staff.id, byUserId: session.userId });
    return { item };
  });
}
