import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { createBloodProduct } from "@/lib/hospital/blood";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("clinical:chart:read", searchParams.get("facilityId") ?? undefined);
    const products = await prisma.bloodProduct.findMany({ where: { facilityId }, orderBy: { name: "asc" } });
    return { products };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("blood:configuration:manage", body?.facilityId);
    if (!body?.code || !body?.name || !body?.componentType) throw new BadRequestError("code, name, and componentType are required.");
    const product = await createBloodProduct({
      facilityId, code: body.code, name: body.name, componentType: body.componentType,
      defaultUnitDescription: body.defaultUnitDescription, storageRequirement: body.storageRequirement, itemId: body.itemId, byUserId: session.userId,
    });
    return { product };
  });
}
