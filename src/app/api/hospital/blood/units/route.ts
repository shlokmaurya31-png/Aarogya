import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { registerBloodUnit } from "@/lib/hospital/blood";
import type { Prisma } from "@prisma/client";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("clinical:chart:read", searchParams.get("facilityId") ?? undefined);
    const status = searchParams.get("status");
    const productId = searchParams.get("productId");
    const where: Prisma.BloodUnitWhereInput = { facilityId, ...(status ? { status: status as never } : {}), ...(productId ? { productId } : {}) };
    const units = await prisma.bloodUnit.findMany({ where, include: { product: true }, orderBy: [{ status: "asc" }, { expiresAt: "asc" }], take: 200 });
    return { units };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("blood:unit:manage", body?.facilityId);
    if (!staff) throw new BadRequestError("Blood units must be registered by a staff account.");
    if (!body?.productId || !body?.unitNumber) throw new BadRequestError("productId and unitNumber are required.");
    const unit = await registerBloodUnit({
      facilityId, productId: body.productId, unitNumber: body.unitNumber, aboGroup: body.aboGroup, rhStatus: body.rhStatus,
      collectedAt: body.collectedAt ? new Date(body.collectedAt) : undefined, expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
      itemLotId: body.itemLotId, locationId: body.locationId, donorReference: body.donorReference, sourceOrganization: body.sourceOrganization,
      collectionEventRef: body.collectionEventRef, registeredByStaffId: staff.id, byUserId: session.userId,
    });
    return { unit };
  });
}
