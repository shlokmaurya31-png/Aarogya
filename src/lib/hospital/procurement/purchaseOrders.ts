import type { Prisma, UnitOfMeasure } from "@prisma/client";
import { BadRequestError } from "@/lib/auth/rbac";
import { assertItemInFacility } from "@/lib/hospital/inventory/facilityScope";
import { nextPurchaseOrderSequence, formatSequenceNumber } from "./sequence";
import { computeLineTotal, computePurchaseOrderTotals } from "./pricing";

type Tx = Prisma.TransactionClient;

export class PurchaseOrderConcurrencyError extends BadRequestError {
  constructor(status: string) {
    super(`Purchase order is not in the expected state (currently ${status}).`);
  }
}

export class SameActorApprovalError extends BadRequestError {
  constructor() {
    super("The same staff member cannot both create and approve a purchase order.");
  }
}

export async function createPurchaseOrderDraft(
  tx: Tx,
  input: { facilityId: string; supplierId: string; requisitionId?: string; expectedDeliveryDate?: Date; createdByStaffId: string }
) {
  const supplier = await tx.supplier.findUniqueOrThrow({ where: { id: input.supplierId } });
  if (supplier.facilityId !== input.facilityId) throw new BadRequestError("Supplier does not belong to this facility.");
  if (input.requisitionId) {
    const requisition = await tx.purchaseRequisition.findUniqueOrThrow({ where: { id: input.requisitionId } });
    if (requisition.facilityId !== input.facilityId) throw new BadRequestError("Requisition does not belong to this facility.");
  }
  return tx.purchaseOrder.create({
    data: {
      facilityId: input.facilityId,
      supplierId: input.supplierId,
      requisitionId: input.requisitionId,
      expectedDeliveryDate: input.expectedDeliveryDate,
      createdByStaffId: input.createdByStaffId,
      idempotencyKey: `po-draft-${input.facilityId}-${input.createdByStaffId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    },
  });
}

async function recomputeTotals(tx: Tx, purchaseOrderId: string) {
  const lines = await tx.purchaseOrderLine.findMany({ where: { purchaseOrderId } });
  const totals = computePurchaseOrderTotals(lines);
  await tx.purchaseOrder.update({ where: { id: purchaseOrderId }, data: totals });
}

export async function addPurchaseOrderLine(
  tx: Tx,
  purchaseOrderId: string,
  input: { itemId: string; orderedQuantity: number; unit: UnitOfMeasure; unitPriceMinor: number; taxPercent?: number }
) {
  const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: purchaseOrderId } });
  if (po.status !== "DRAFT") throw new BadRequestError("Lines can only be added while the purchase order is DRAFT.");
  if (input.orderedQuantity <= 0) throw new BadRequestError("Ordered quantity must be positive.");
  if (input.unitPriceMinor < 0) throw new BadRequestError("Unit price cannot be negative.");
  await assertItemInFacility(tx, input.itemId, po.facilityId);

  const lineTotalMinor = computeLineTotal({ orderedQuantity: input.orderedQuantity, unitPriceMinor: input.unitPriceMinor, taxPercent: input.taxPercent });
  const line = await tx.purchaseOrderLine.create({
    data: { purchaseOrderId, itemId: input.itemId, orderedQuantity: input.orderedQuantity, unit: input.unit, unitPriceMinor: input.unitPriceMinor, taxPercent: input.taxPercent ?? 0, lineTotalMinor },
  });
  await recomputeTotals(tx, purchaseOrderId);
  return line;
}

/** Assigns orderNumber atomically via the guarded sequence CAS, inside the same guarded status transition. */
export async function submitForApproval(tx: Tx, purchaseOrderId: string) {
  const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: purchaseOrderId }, include: { lines: true } });
  if (po.lines.length === 0) throw new BadRequestError("Cannot submit a purchase order with no lines.");

  const fiscalYear = new Date().getFullYear();
  const seq = await nextPurchaseOrderSequence(tx, { facilityId: po.facilityId, fiscalYear });
  const orderNumber = formatSequenceNumber("PO", fiscalYear, seq);

  const result = await tx.purchaseOrder.updateMany({ where: { id: purchaseOrderId, status: "DRAFT" }, data: { status: "PENDING_APPROVAL", orderNumber } });
  if (result.count !== 1) throw new PurchaseOrderConcurrencyError(po.status);
  return tx.purchaseOrder.findUniqueOrThrow({ where: { id: purchaseOrderId } });
}

/** Guarded status CAS closes the PO-approval race (#7). Same-actor guard prevents silent self-approval. */
export async function approvePurchaseOrder(tx: Tx, purchaseOrderId: string, input: { approvedByStaffId: string }) {
  const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: purchaseOrderId } });
  if (po.createdByStaffId === input.approvedByStaffId) throw new SameActorApprovalError();

  const result = await tx.purchaseOrder.updateMany({
    where: { id: purchaseOrderId, status: "PENDING_APPROVAL" },
    data: { status: "APPROVED", approvedByStaffId: input.approvedByStaffId, approvedAt: new Date() },
  });
  if (result.count !== 1) throw new PurchaseOrderConcurrencyError(po.status);
  return tx.purchaseOrder.findUniqueOrThrow({ where: { id: purchaseOrderId } });
}

export async function markSent(tx: Tx, purchaseOrderId: string) {
  const result = await tx.purchaseOrder.updateMany({ where: { id: purchaseOrderId, status: "APPROVED" }, data: { status: "SENT", sentAt: new Date() } });
  if (result.count !== 1) throw new PurchaseOrderConcurrencyError("not APPROVED");
  return tx.purchaseOrder.findUniqueOrThrow({ where: { id: purchaseOrderId } });
}

export async function cancelPurchaseOrder(tx: Tx, purchaseOrderId: string, input: { reason: string }) {
  const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: purchaseOrderId } });
  if (!["DRAFT", "PENDING_APPROVAL", "APPROVED", "SENT"].includes(po.status)) throw new PurchaseOrderConcurrencyError(po.status);
  const result = await tx.purchaseOrder.updateMany({ where: { id: purchaseOrderId, status: po.status }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelledReason: input.reason } });
  if (result.count !== 1) throw new PurchaseOrderConcurrencyError(po.status);
  return tx.purchaseOrder.findUniqueOrThrow({ where: { id: purchaseOrderId } });
}

export async function closePurchaseOrder(tx: Tx, purchaseOrderId: string) {
  const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: purchaseOrderId } });
  if (!["RECEIVED", "PARTIALLY_RECEIVED"].includes(po.status)) throw new PurchaseOrderConcurrencyError(po.status);
  const result = await tx.purchaseOrder.updateMany({ where: { id: purchaseOrderId, status: po.status }, data: { status: "CLOSED", closedAt: new Date() } });
  if (result.count !== 1) throw new PurchaseOrderConcurrencyError(po.status);
  return tx.purchaseOrder.findUniqueOrThrow({ where: { id: purchaseOrderId } });
}

/** Called after each goods-receipt approval — flips SENT/APPROVED -> PARTIALLY_RECEIVED -> RECEIVED purely from the lines' own receivedQuantity totals, never a separately-set flag. */
export async function recomputeReceivingStatus(tx: Tx, purchaseOrderId: string) {
  const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: purchaseOrderId }, include: { lines: true } });
  if (!["SENT", "APPROVED", "PARTIALLY_RECEIVED"].includes(po.status)) return po;

  const fullyReceived = po.lines.every((l) => l.receivedQuantity >= l.orderedQuantity);
  const anyReceived = po.lines.some((l) => l.receivedQuantity > 0);
  const nextStatus = fullyReceived ? "RECEIVED" : anyReceived ? "PARTIALLY_RECEIVED" : po.status;
  if (nextStatus === po.status) return po;

  await tx.purchaseOrder.updateMany({ where: { id: purchaseOrderId, status: po.status }, data: { status: nextStatus } });
  return tx.purchaseOrder.findUniqueOrThrow({ where: { id: purchaseOrderId } });
}
