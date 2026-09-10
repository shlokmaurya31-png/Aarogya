import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { createDietOrder } from "@/lib/hospital/operations/service";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("operations:command:view", searchParams.get("facilityId") ?? undefined);
    const patientId = searchParams.get("patientId");
    const orders = await prisma.dietOrder.findMany({ where: { facilityId, ...(patientId ? { patientId } : {}) }, orderBy: { createdAt: "desc" }, take: 200 });
    return { orders };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("dietary:order:manage", body?.facilityId);
    if (!staff) throw new BadRequestError("Diet orders require a staff account.");
    if (!body?.patientId || !body?.encounterId || !body?.dietType) throw new BadRequestError("patientId, encounterId, and dietType are required.");
    const order = await createDietOrder({ facilityId, patientId: body.patientId, encounterId: body.encounterId, dietType: body.dietType, restrictions: body.restrictions, effectiveTo: body.effectiveTo ? new Date(body.effectiveTo) : undefined, orderedByStaffId: staff.id, notes: body.notes, byUserId: session.userId });
    return { order };
  });
}
