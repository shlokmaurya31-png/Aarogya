import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { updateStockLocation } from "@/lib/hospital/inventory/locations";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("inventory:item:view", searchParams.get("facilityId") ?? undefined);
    const location = await prisma.stockLocation.findUnique({ where: { id } });
    if (!location || location.facilityId !== facilityId) throw new NotFoundError("Location not found.");
    return { location };
  });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("inventory:location:manage", body?.facilityId);

    const existing = await prisma.stockLocation.findUnique({ where: { id } });
    if (!existing || existing.facilityId !== facilityId) throw new NotFoundError("Location not found.");

    const location = await prisma.$transaction((tx) => updateStockLocation(tx, id, body ?? {}));
    await recordAuditEvent("hospital.inventory.locationUpdated", session.userId, { locationId: id }, { facilityId });
    return { location };
  });
}
