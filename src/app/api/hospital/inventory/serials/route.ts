import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { registerSerial } from "@/lib/hospital/inventory/inventoryAdvanced";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("inventory:stock:view", searchParams.get("facilityId") ?? undefined);
    const itemId = searchParams.get("itemId");
    const serials = await prisma.inventorySerial.findMany({ where: { facilityId, ...(itemId ? { itemId } : {}) }, orderBy: { createdAt: "desc" }, take: 200 });
    return { serials };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("inventory:serial:manage", body?.facilityId);
    if (!body?.itemId || !body?.serialNumber) throw new BadRequestError("itemId and serialNumber are required.");
    const serial = await registerSerial({ facilityId, itemId: body.itemId, serialNumber: body.serialNumber, lotId: body.lotId, currentLocationId: body.currentLocationId, byUserId: session.userId });
    return { serial };
  });
}
