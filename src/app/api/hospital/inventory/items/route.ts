import { NextRequest } from "next/server";
import type { ItemCategory, UnitOfMeasure } from "@prisma/client";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { createItem, listItems } from "@/lib/hospital/inventory/items";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("inventory:item:view", searchParams.get("facilityId") ?? undefined);
    const items = await listItems(prisma, {
      facilityId,
      category: (searchParams.get("category") as ItemCategory | null) ?? undefined,
      active: searchParams.get("active") ? searchParams.get("active") === "true" : undefined,
      search: searchParams.get("search") ?? undefined,
      cursor: searchParams.get("cursor") ?? undefined,
      take: searchParams.get("take") ? Number(searchParams.get("take")) : undefined,
    });
    return { items };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("inventory:item:manage", body?.facilityId);

    const { sku, name, category, baseUnit } = body ?? {};
    if (!sku || typeof sku !== "string") throw new BadRequestError("sku is required.");
    if (!name || typeof name !== "string") throw new BadRequestError("name is required.");
    if (!category || typeof category !== "string") throw new BadRequestError("category is required.");
    if (!baseUnit || typeof baseUnit !== "string") throw new BadRequestError("baseUnit is required.");

    const item = await prisma.$transaction((tx) =>
      createItem(tx, {
        facilityId: body?.global ? null : facilityId,
        sku,
        name,
        description: body?.description,
        category: category as ItemCategory,
        baseUnit: baseUnit as UnitOfMeasure,
        trackLots: body?.trackLots,
        trackExpiry: body?.trackExpiry,
        trackSerial: body?.trackSerial,
        reorderMinLevel: body?.reorderMinLevel,
        reorderMaxLevel: body?.reorderMaxLevel,
        reorderPoint: body?.reorderPoint,
        reorderQuantity: body?.reorderQuantity,
        preferredSupplierId: body?.preferredSupplierId,
      })
    );
    await recordAuditEvent("hospital.inventory.itemCreated", session.userId, { itemId: item.id, sku }, { facilityId });
    return { item };
  });
}
