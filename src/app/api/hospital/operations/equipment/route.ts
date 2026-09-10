import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { createEquipment } from "@/lib/hospital/operations/service";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("operations:command:view", searchParams.get("facilityId") ?? undefined);
    const status = searchParams.get("status");
    const equipment = await prisma.biomedicalEquipment.findMany({ where: { facilityId, ...(status ? { status } : {}) }, orderBy: { assetTag: "asc" }, take: 300 });
    return { equipment };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("biomedical:manage", body?.facilityId);
    if (!body?.assetTag || !body?.category) throw new BadRequestError("assetTag and category are required.");
    const equipment = await createEquipment({ facilityId, assetTag: body.assetTag, category: body.category, serialNumber: body.serialNumber, manufacturer: body.manufacturer, model: body.model, departmentId: body.departmentId, locationLabel: body.locationLabel, warrantyUntil: body.warrantyUntil ? new Date(body.warrantyUntil) : undefined, nextServiceAt: body.nextServiceAt ? new Date(body.nextServiceAt) : undefined, byUserId: session.userId });
    return { equipment };
  });
}
