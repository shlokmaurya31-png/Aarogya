import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { getItemDetail, updateItem } from "@/lib/hospital/inventory/items";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("inventory:item:view", searchParams.get("facilityId") ?? undefined);
    const detail = await getItemDetail(prisma, id, facilityId);
    return detail;
  });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("inventory:item:manage", body?.facilityId);

    const item = await prisma.$transaction((tx) => updateItem(tx, id, body ?? {}));
    await recordAuditEvent("hospital.inventory.itemUpdated", session.userId, { itemId: id }, { facilityId });
    return { item };
  });
}
