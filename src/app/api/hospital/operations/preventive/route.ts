import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { schedulePreventiveMaintenance } from "@/lib/hospital/operations/service";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("operations:command:view", searchParams.get("facilityId") ?? undefined);
    const items = await prisma.preventiveMaintenance.findMany({ where: { facilityId }, orderBy: { dueAt: "asc" }, take: 200 });
    return { items };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("biomedical:manage", body?.facilityId);
    if (!body?.maintenanceType || !body?.dueAt) throw new BadRequestError("maintenanceType and dueAt are required.");
    const item = await schedulePreventiveMaintenance({ facilityId, maintenanceType: body.maintenanceType, dueAt: new Date(body.dueAt), equipmentId: body.equipmentId, assetLabel: body.assetLabel, nextDueAt: body.nextDueAt ? new Date(body.nextDueAt) : undefined, byUserId: session.userId });
    return { item };
  });
}
