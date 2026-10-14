import type { Prisma, ItemCategory, UnitOfMeasure } from "@prisma/client";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { TenantAccessError } from "@/lib/auth/tenantContext";
import { computeAvailable } from "./stockBalance";
import { clampPageSize } from "./expiry";
import { textContains } from "@/lib/search";
import { assertItemInFacility } from "./facilityScope";

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

/**
 * Updates the caller's own facility item. Another facility's item is a 404,
 * identical to an unknown ID. A global catalog item is shared by every
 * facility, so one facility may not change it (403). Ownership and SKU are
 * never changed here: `facilityId` and `sku` are dropped from the input, so an
 * update can't move an item into another tenant.
 */
export async function updateItem(tx: Tx, itemId: string, facilityId: string, input: Partial<Omit<CreateItemInput, "sku">> & { sku?: unknown }) {
  const item = await tx.item.findUnique({ where: { id: itemId } });
  if (!item || (item.facilityId !== null && item.facilityId !== facilityId)) throw new NotFoundError("Item not found.");
  if (item.facilityId === null) throw new TenantAccessError("Global catalog items can't be changed from a facility.");
  const { facilityId: _ignoredFacility, sku: _ignoredSku, ...data } = input;
  return tx.item.update({ where: { id: itemId }, data });
}

export async function listItems(
  tx: Tx,
  filters: { facilityId: string; category?: ItemCategory; active?: boolean; search?: string; cursor?: string; take?: number }
) {
  return tx.item.findMany({
    where: {
      category: filters.category,
      active: filters.active,
      // Facility scope and search are both OR-groups, so they must be ANDed:
      // as two `OR` keys on one object, the search silently replaced the
      // facility scope and returned other facilities' items. facilityId is
      // required: an optional scope would list every facility's items.
      AND: [
        { OR: [{ facilityId: filters.facilityId }, { facilityId: null }] },
        filters.search ? { OR: [{ name: textContains(filters.search) }, { sku: textContains(filters.search) }] } : {},
      ],
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: clampPageSize(filters.take),
    ...(filters.cursor ? { skip: 1, cursor: { id: filters.cursor } } : {}),
  });
}

/** Backs the Item Detail UI: stock by location/lot, reserved, available, recent movements, pending POs, reorder state. */
export async function getItemDetail(tx: Tx, itemId: string, facilityId: string) {
  // The caller's facility or a global catalog item; another facility's item is
  // reported exactly like an unknown one.
  const item = await assertItemInFacility(tx, itemId, facilityId);

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
    orderBy: [{ purchaseOrderId: "asc" }, { id: "asc" }],
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
