import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { reserveStock, releaseReservation } from "@/lib/hospital/inventory/reservation";
import { issueStock } from "@/lib/hospital/inventory/issue";
import type { Prisma, DepartmentSupplyRequestStatus, InventorySerialStatus } from "@prisma/client";

/**
 * Enterprise inventory depth (Phase B8) — valuation, the GENERIC department
 * supply request, and minimal serialized-item identity. Everything runs over
 * the ONE canonical inventory (Item/ItemLot/StockBalance/StockLedgerEntry/
 * StockReservation); reserve/issue go through the existing guarded
 * reserveStock/issueStock services — never a second ledger, never a direct
 * StockBalance write. No per-department inventory.
 */

// ── Inventory valuation (DB-backed, on-hand × lot cost) ─────────────────────
/**
 * Operational inventory valuation. Value = Σ (StockBalance.onHandQty ×
 * ItemLot.unitCostMinor) — a defensible actual-lot-cost basis (each lot keeps
 * the cost it was received at; historical valuation is never rewritten). Lots
 * with no recorded cost contribute quantity but 0 value (surfaced as
 * uncostedLots). Aggregations are computed server-side, bounded, and grouped.
 */
export async function getInventoryValuation(facilityId: string, opts?: { locationId?: string; category?: string }) {
  const balances = await prisma.stockBalance.findMany({
    where: { facilityId, onHandQty: { gt: 0 }, ...(opts?.locationId ? { locationId: opts.locationId } : {}), ...(opts?.category ? { item: { category: opts.category as never } } : {}) },
    include: { item: { select: { id: true, name: true, category: true } }, lot: { select: { unitCostMinor: true, status: true, expiresAt: true } }, location: { select: { id: true, name: true } } },
    take: 5000,
  });
  let totalQty = 0, totalValueMinor = 0, uncostedLots = 0, quarantinedValueMinor = 0, expiringValueMinor = 0;
  const byCategory = new Map<string, { quantity: number; valueMinor: number }>();
  const byLocation = new Map<string, { name: string; quantity: number; valueMinor: number }>();
  const soon = Date.now() + 30 * 24 * 3600_000;
  for (const b of balances) {
    const cost = b.lot.unitCostMinor;
    const lineValue = cost != null ? Math.round(b.onHandQty * cost) : 0;
    if (cost == null) uncostedLots += 1;
    totalQty += b.onHandQty;
    totalValueMinor += lineValue;
    if (b.lot.status === "QUARANTINED" || b.lot.status === "RECALLED") quarantinedValueMinor += lineValue;
    if (b.lot.expiresAt && b.lot.expiresAt.getTime() <= soon) expiringValueMinor += lineValue;
    const cat = b.item.category;
    const c = byCategory.get(cat) ?? { quantity: 0, valueMinor: 0 }; c.quantity += b.onHandQty; c.valueMinor += lineValue; byCategory.set(cat, c);
    const loc = byLocation.get(b.locationId) ?? { name: b.location.name, quantity: 0, valueMinor: 0 }; loc.quantity += b.onHandQty; loc.valueMinor += lineValue; byLocation.set(b.locationId, loc);
  }
  return {
    totalOnHandQty: totalQty, totalValueMinor, uncostedLots, quarantinedValueMinor, expiringValueMinor,
    byCategory: [...byCategory.entries()].map(([category, v]) => ({ category, ...v })),
    byLocation: [...byLocation.entries()].map(([locationId, v]) => ({ locationId, ...v })),
  };
}

/** Reorder SUGGESTIONS only (brief §62) — never an automatic PO. Items whose total on-hand is at/below their configured reorder point. */
export async function getReorderSuggestions(facilityId: string) {
  const items = await prisma.item.findMany({ where: { facilityId, active: true, reorderPoint: { not: null } }, select: { id: true, name: true, sku: true, category: true, reorderPoint: true, reorderQuantity: true, preferredSupplierId: true } });
  const suggestions = [];
  for (const item of items) {
    const agg = await prisma.stockBalance.aggregate({ where: { facilityId, itemId: item.id }, _sum: { onHandQty: true, reservedQty: true } });
    const onHand = agg._sum.onHandQty ?? 0;
    const available = onHand - (agg._sum.reservedQty ?? 0);
    if (available <= (item.reorderPoint ?? 0)) {
      suggestions.push({ itemId: item.id, name: item.name, sku: item.sku, category: item.category, onHand, available, reorderPoint: item.reorderPoint, suggestedQuantity: item.reorderQuantity ?? null, preferredSupplierId: item.preferredSupplierId });
    }
  }
  return suggestions;
}

// ── Generic department supply request (one model for every department) ──────
const REQUEST_TRANSITIONS: Record<DepartmentSupplyRequestStatus, DepartmentSupplyRequestStatus[]> = {
  REQUESTED: ["APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: ["RESERVED", "ISSUED", "CANCELLED"],
  RESERVED: ["ISSUED", "CANCELLED"],
  ISSUED: ["RECEIVED"],
  RECEIVED: [],
  CANCELLED: [],
  REJECTED: [],
};
export function isDepartmentRequestTransitionAllowed(from: DepartmentSupplyRequestStatus, to: DepartmentSupplyRequestStatus): boolean {
  return REQUEST_TRANSITIONS[from]?.includes(to) ?? false;
}

export async function createDepartmentRequest(input: { facilityId: string; itemId: string; quantity: number; unit?: string; departmentId?: string; requestingLocationId?: string; urgency?: string; reason?: string; patientId?: string; encounterId?: string; requestedByStaffId: string; byUserId: string }) {
  if (input.quantity <= 0) throw new BadRequestError("Quantity must be positive.");
  const item = await prisma.item.findUnique({ where: { id: input.itemId } });
  if (!item || (item.facilityId && item.facilityId !== input.facilityId)) throw new NotFoundError("Item not found in this facility.");
  const req = await prisma.departmentSupplyRequest.create({
    data: { facilityId: input.facilityId, itemId: input.itemId, quantity: input.quantity, unit: input.unit, departmentId: input.departmentId, requestingLocationId: input.requestingLocationId, urgency: input.urgency ?? "ROUTINE", reason: input.reason, patientId: input.patientId, encounterId: input.encounterId, requestedByStaffId: input.requestedByStaffId },
  });
  await recordAuditEvent("hospital.inventory.deptRequestCreated", input.byUserId, { requestId: req.id, itemId: input.itemId, quantity: input.quantity, urgency: req.urgency }, { facilityId: input.facilityId, patientId: input.patientId, encounterId: input.encounterId });
  return req;
}

/** Guarded department-request lifecycle. RESERVED reserves via canonical reserveStock; ISSUED consumes via canonical issueStock; single-winner via status-preconditioned updateMany. */
export async function transitionDepartmentRequest(input: { requestId: string; facilityId: string; to: DepartmentSupplyRequestStatus; actorStaffId: string; fulfillLocationId?: string; lotId?: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const req = await tx.departmentSupplyRequest.findUnique({ where: { id: input.requestId } });
    if (!req || req.facilityId !== input.facilityId) throw new NotFoundError("Supply request not found.");
    if (!isDepartmentRequestTransitionAllowed(req.status, input.to)) throw new BadRequestError(`Illegal request transition ${req.status} -> ${input.to}.`);
    const data: Prisma.DepartmentSupplyRequestUpdateManyMutationInput = { status: input.to, reviewedByStaffId: input.actorStaffId };
    if (input.fulfillLocationId) data.fulfillLocationId = input.fulfillLocationId;

    if (input.to === "RESERVED") {
      const loc = input.fulfillLocationId ?? req.fulfillLocationId;
      if (!loc) throw new BadRequestError("A fulfill location is required to reserve.");
      const { reservation } = await reserveStock(tx, { facilityId: req.facilityId, itemId: req.itemId, locationId: loc, quantity: req.quantity, lotId: input.lotId, reservedForType: "DepartmentSupplyRequest", reservedForId: req.id, patientId: req.patientId ?? undefined, encounterId: req.encounterId ?? undefined, requestedByStaffId: input.actorStaffId, actorUserId: input.byUserId, idempotencyKey: `deptreq-resv-${req.id}` });
      data.reservationId = reservation.id;
    } else if (input.to === "ISSUED") {
      const loc = input.fulfillLocationId ?? req.fulfillLocationId;
      if (!loc) throw new BadRequestError("A fulfill location is required to issue.");
      if (req.reservationId) await releaseReservation(tx, req.reservationId, { byUserId: input.byUserId }).catch(() => undefined);
      await issueStock(tx, { facilityId: req.facilityId, itemId: req.itemId, locationId: loc, quantity: req.quantity, lotId: input.lotId, requestedByStaffId: input.actorStaffId, actorUserId: input.byUserId, reason: "Department supply issue", patientId: req.patientId ?? undefined, encounterId: req.encounterId ?? undefined, sourceType: "DepartmentSupplyRequest", sourceId: req.id });
    } else if (input.to === "CANCELLED" || input.to === "REJECTED") {
      if (req.reservationId) await releaseReservation(tx, req.reservationId, { byUserId: input.byUserId }).catch(() => undefined);
    }

    const r = await tx.departmentSupplyRequest.updateMany({ where: { id: req.id, status: req.status }, data });
    if (r.count !== 1) throw new BadRequestError("Request changed state concurrently — refresh and try again.");
    await tx.auditEvent.create({ data: { type: "hospital.inventory.deptRequestUpdated", userId: input.byUserId, detail: { requestId: req.id, from: req.status, to: input.to }, facilityId: req.facilityId, patientId: req.patientId, encounterId: req.encounterId } });
    return tx.departmentSupplyRequest.findUniqueOrThrow({ where: { id: req.id } });
  });
}

// ── Serialized-item identity (inventory identity only) ──────────────────────
const SERIAL_TRANSITIONS: Record<InventorySerialStatus, InventorySerialStatus[]> = {
  IN_STOCK: ["RESERVED", "ISSUED", "DISPOSED"],
  RESERVED: ["IN_STOCK", "ISSUED", "DISPOSED"],
  ISSUED: ["RETURNED", "DISPOSED"],
  RETURNED: ["IN_STOCK", "DISPOSED"],
  DISPOSED: [],
};

export async function registerSerial(input: { facilityId: string; itemId: string; serialNumber: string; lotId?: string; currentLocationId?: string; byUserId: string }) {
  const item = await prisma.item.findUnique({ where: { id: input.itemId } });
  if (!item || (item.facilityId && item.facilityId !== input.facilityId)) throw new NotFoundError("Item not found in this facility.");
  const serial = await prisma.inventorySerial.create({
    data: { facilityId: input.facilityId, itemId: input.itemId, serialNumber: input.serialNumber, lotId: input.lotId, currentLocationId: input.currentLocationId, receivedAt: new Date() },
  }).catch((e: unknown) => {
    if (e instanceof Error && /unique/i.test(e.message)) throw new BadRequestError("A serial with that number already exists in this facility.");
    throw e;
  });
  await recordAuditEvent("hospital.inventory.serialRegistered", input.byUserId, { serialId: serial.id, serialNumber: input.serialNumber, itemId: input.itemId }, { facilityId: input.facilityId });
  return serial;
}

export async function transitionSerial(input: { serialId: string; facilityId: string; to: InventorySerialStatus; currentLocationId?: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const serial = await tx.inventorySerial.findUnique({ where: { id: input.serialId } });
    if (!serial || serial.facilityId !== input.facilityId) throw new NotFoundError("Serial not found.");
    if (!(SERIAL_TRANSITIONS[serial.status]?.includes(input.to) ?? false)) throw new BadRequestError(`Illegal serial transition ${serial.status} -> ${input.to}.`);
    const r = await tx.inventorySerial.updateMany({ where: { id: serial.id, status: serial.status }, data: { status: input.to, ...(input.currentLocationId ? { currentLocationId: input.currentLocationId } : {}) } });
    if (r.count !== 1) throw new BadRequestError("Serial changed state concurrently — refresh and try again.");
    await tx.auditEvent.create({ data: { type: "hospital.inventory.serialUpdated", userId: input.byUserId, detail: { serialId: serial.id, from: serial.status, to: input.to }, facilityId: serial.facilityId } });
    return tx.inventorySerial.findUniqueOrThrow({ where: { id: serial.id } });
  });
}
