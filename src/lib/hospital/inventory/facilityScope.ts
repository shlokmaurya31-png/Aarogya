import type { Prisma } from "@prisma/client";
import { NotFoundError } from "@/lib/auth/rbac";

type Tx = Prisma.TransactionClient;

/**
 * Facility-isolation guards for every client-suppliable resource ID this
 * module accepts (itemId, locationId, lotId, supplierId, purchaseOrderId,
 * ...). Every stock-mutating service function calls these BEFORE touching
 * any balance/ledger row — without them, a caller correctly scoped to
 * their own facility by requireFacilityStaff could still pass another
 * facility's itemId/locationId/lotId and have it silently accepted (an
 * IDOR/cross-tenant-write gap), since the service layer otherwise never
 * re-derives facility ownership from the IDs themselves. `Item.facilityId`
 * may legitimately be null (a global/org-wide catalog item, per
 * LabTestCatalog's precedent) — those are allowed at any facility; a
 * facility-scoped item must match exactly.
 */

export class ResourceFacilityMismatchError extends NotFoundError {
  constructor(resource: string) {
    super(`${resource} not found.`);
  }
}

export async function assertItemInFacility(tx: Tx, itemId: string, facilityId: string) {
  const item = await tx.item.findUnique({ where: { id: itemId } });
  if (!item || (item.facilityId !== null && item.facilityId !== facilityId)) throw new ResourceFacilityMismatchError("Item");
  return item;
}

export async function assertLocationInFacility(tx: Tx, locationId: string, facilityId: string) {
  const location = await tx.stockLocation.findUnique({ where: { id: locationId } });
  if (!location || location.facilityId !== facilityId) throw new ResourceFacilityMismatchError("Location");
  return location;
}

export async function assertLotInFacility(tx: Tx, lotId: string, facilityId: string) {
  const lot = await tx.itemLot.findUnique({ where: { id: lotId } });
  if (!lot || lot.facilityId !== facilityId) throw new ResourceFacilityMismatchError("Lot");
  return lot;
}

export async function assertSupplierInFacility(tx: Tx, supplierId: string, facilityId: string) {
  const supplier = await tx.supplier.findUnique({ where: { id: supplierId } });
  if (!supplier || supplier.facilityId !== facilityId) throw new ResourceFacilityMismatchError("Supplier");
  return supplier;
}

export async function assertPurchaseOrderInFacility(tx: Tx, purchaseOrderId: string, facilityId: string) {
  const po = await tx.purchaseOrder.findUnique({ where: { id: purchaseOrderId } });
  if (!po || po.facilityId !== facilityId) throw new ResourceFacilityMismatchError("Purchase order");
  return po;
}

export async function assertPurchaseOrderLineInFacility(tx: Tx, purchaseOrderLineId: string, facilityId: string) {
  const line = await tx.purchaseOrderLine.findUnique({ where: { id: purchaseOrderLineId }, include: { purchaseOrder: true } });
  if (!line || line.purchaseOrder.facilityId !== facilityId) throw new ResourceFacilityMismatchError("Purchase order line");
  return line;
}
