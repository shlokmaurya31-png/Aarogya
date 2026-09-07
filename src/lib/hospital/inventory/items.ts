import type { Prisma, ItemCategory, UnitOfMeasure } from "@prisma/client";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { computeAvailable } from "./stockBalance";
import { clampPageSize } from "./expiry";

type Tx = Prisma.TransactionClient;

export interface CreateItemInput {
  facilityId?: string | null;
  sku: string;
  name: string;
  description?: string;
  category: ItemCategory;
  baseUnit: UnitOfMeasure;
  trackLots?: boolean;
  trackExpiry?: boolean;
  trackSerial?: boolean;
  reorderMinLevel?: number;
  reorderMaxLevel?: number;
  reorderPoint?: number;
  reorderQuantity?: number;
  preferredSupplierId?: string;
}

export async function createItem(tx: Tx, input: CreateItemInput) {
  const existing = await tx.item.findUnique({ where: { sku: input.sku } });
  if (existing) throw new BadRequestError(`Item SKU "${input.sku}" already exists.`);
  if (input.preferredSupplierId && input.facilityId) {
    const supplier = await tx.supplier.findUniqueOrThrow({ where: { id: input.preferredSupplierId } });
    if (supplier.facilityId !== input.facilityId) throw new BadRequestError("preferredSupplierId does not belong to this facility.");
  }
  return tx.item.create({
    data: {
      facilityId: input.facilityId ?? null,
      sku: input.sku,
      name: input.name,
      description: input.description,
      category: input.category,
      baseUnit: input.baseUnit,
      trackLots: input.trackLots ?? true,
      trackExpiry: input.trackExpiry ?? true,
      trackSerial: input.trackSerial ?? false,
      reorderMinLevel: input.reorderMinLevel,
      reorderMaxLevel: input.reorderMaxLevel,
      reorderPoint: input.reorderPoint,
      reorderQuantity: input.reorderQuantity,
      preferredSupplierId: input.preferredSupplierId,
    },
  });
}

export async function updateItem(tx: Tx, itemId: string, input: Partial<Omit<CreateItemInput, "sku">>) {
  await tx.item.findUniqueOrThrow({ where: { id: itemId } });
  return tx.item.update({ where: { id: itemId }, data: input });
}

export async function listItems(
  tx: Tx,
  filters: { facilityId?: string; category?: ItemCategory; active?: boolean; search?: string; cursor?: string; take?: number }
) {
  return tx.item.findMany({
    where: {
      OR: filters.facilityId ? [{ facilityId: filters.facilityId }, { facilityId: null }] : undefined,
      category: filters.category,
      active: filters.active,
      ...(filters.search ? { OR: [{ name: { contains: filters.search } }, { sku: { contains: filters.search } }] } : {}),
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: clampPageSize(filters.take),
    ...(filters.cursor ? { skip: 1, cursor: { id: filters.cursor } } : {}),
  });
}

/** Backs the Item Detail UI: stock by location/lot, reserved, available, recent movements, pending POs, reorder state. */
export async function getItemDetail(tx: Tx, itemId: string, facilityId: string) {
  const item = await tx.item.findUnique({ where: { id: itemId } });
  if (!item) throw new NotFoundError("Item not found.");

  const balances = await tx.stockBalance.findMany({
    where: { itemId, facilityId },
    include: { lot: true, location: true },
    orderBy: [{ lot: { expiresAt: "asc" } }],
  });
  const recentMovements = await tx.stockLedgerEntry.findMany({
    where: { itemId, facilityId },
    orderBy: { postedAt: "desc" },
    take: 20,
  });
  const pendingLines = await tx.purchaseOrderLine.findMany({
    where: { itemId, purchaseOrder: { facilityId, status: { in: ["APPROVED", "SENT", "PARTIALLY_RECEIVED"] } } },
    include: { purchaseOrder: { select: { id: true, orderNumber: true, status: true, expectedDeliveryDate: true } } },
  });

  const totalOnHand = balances.reduce((sum, b) => sum + b.onHandQty, 0);
  const totalReserved = balances.reduce((sum, b) => sum + b.reservedQty, 0);

  return {
    item,
    balances: balances.map((b) => ({ ...b, available: computeAvailable(b) })),
    totalOnHand,
    totalReserved,
    totalAvailable: totalOnHand - totalReserved,
    recentMovements,
    pendingPurchaseOrderLines: pendingLines,
    belowReorderPoint: item.reorderPoint != null && totalOnHand <= item.reorderPoint,
  };
}
