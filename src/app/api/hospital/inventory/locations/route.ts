import { NextRequest } from "next/server";
import type { LocationType } from "@prisma/client";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { createStockLocation, listLocations } from "@/lib/hospital/inventory/locations";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("inventory:item:view", searchParams.get("facilityId") ?? undefined);
    const locations = await listLocations(prisma, facilityId, { active: searchParams.get("active") ? searchParams.get("active") === "true" : undefined });
    return { locations };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("inventory:location:manage", body?.facilityId);

    const { name, type } = body ?? {};
    if (!name || typeof name !== "string") throw new BadRequestError("name is required.");
    if (!type || typeof type !== "string") throw new BadRequestError("type is required.");

    const location = await prisma.$transaction((tx) => createStockLocation(tx, { facilityId, name, type: type as LocationType, parentLocationId: body?.parentLocationId }));
    await recordAuditEvent("hospital.inventory.locationCreated", session.userId, { locationId: location.id, name }, { facilityId });
    return { location };
  });
}
