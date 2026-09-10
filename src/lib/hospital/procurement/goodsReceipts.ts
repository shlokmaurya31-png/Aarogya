import { randomUUID } from "node:crypto";
import { Prisma, type UnitOfMeasure } from "@prisma/client";
import { BadRequestError } from "@/lib/auth/rbac";
import { getOrCreateLot } from "@/lib/hospital/inventory/lots";
import { getOrCreateStockBalance, atomicIncrementOnHand } from "@/lib/hospital/inventory/stockBalance";
import { postLedgerEntry } from "@/lib/hospital/inventory/ledger";
import { assertItemInFacility, assertLocationInFacility, assertPurchaseOrderInFacility, assertPurchaseOrderLineInFacility } from "@/lib/hospital/inventory/facilityScope";
import { nextGoodsReceiptSequence, formatSequenceNumber } from "./sequence";
import { recomputeReceivingStatus } from "./purchaseOrders";

type Tx = Prisma.TransactionClient;

export class GoodsReceiptConcurrencyError extends BadRequestError {
  constructor(status: string) {
    super(`Goods receipt is not in the expected state (currently ${status}).`);
  }
}

export class SameActorApprovalError extends BadRequestError {
  constructor() {
    super("The same staff member cannot both record and approve a goods receipt.");
  }
}

export class OverReceiptError extends BadRequestError {
  constructor(purchaseOrderLineId: string) {
    super(`Accepting this quantity would receive more than was ordered on line ${purchaseOrderLineId} — over-receipt is rejected by default.`);
  }
}

export interface GoodsReceiptLineInput {
  purchaseOrderLineId: string;
  itemId: string;
  lotNumber: string;
  manufacturer?: string;
  manufacturedAt?: Date;
  expiresAt?: Date;
  acceptedQuantity: number;
  rejectedQuantity?: number;
  rejectionReason?: string;
  unitCostMinor?: number; // Phase B8 — acquisition cost (INR paise) captured at receipt
  locationId: string;
  unit: UnitOfMeasure;
}

/**
 * Records a receiving submission with NO stock effect yet (approval is a
 * separate, gated step). idempotencyKey is the natural key for "this
 * receiving submission" — not purchaseOrderLineId alone, which would
 * wrongly forbid legitimate multiple partial deliveries against the same
 * line. Insert-first idempotency: a retried identical submission returns
 * the existing header and creates no duplicate lines.
 */
export async function recordGoodsReceipt(
  tx: Tx,
  input: { facilityId: string; purchaseOrderId: string; recordedByStaffId: string; lines: GoodsReceiptLineInput[]; notes?: string; idempotencyKey: string }
) {
  if (input.lines.length === 0) throw new BadRequestError("A goods receipt must have at least one line.");
  await assertPurchaseOrderInFacility(tx, input.purchaseOrderId, input.facilityId);
  for (const line of input.lines) {
    await assertItemInFacility(tx, line.itemId, input.facilityId);
    await assertLocationInFacility(tx, line.locationId, input.facilityId);
    const poLine = await assertPurchaseOrderLineInFacility(tx, line.purchaseOrderLineId, input.facilityId);
    if (poLine.purchaseOrderId !== input.purchaseOrderId) throw new BadRequestError(`Purchase order line ${line.purchaseOrderLineId} does not belong to purchase order ${input.purchaseOrderId}.`);
  }
  const id = randomUUID();

  const rowsInserted = await tx.$executeRaw`
    INSERT INTO "GoodsReceipt" (id, "purchaseOrderId", "facilityId", status, "recordedByStaffId", "recordedAt", notes, "idempotencyKey")
    VALUES (${id}, ${input.purchaseOrderId}, ${input.facilityId}, ${Prisma.raw("'RECORDED'")}, ${input.recordedByStaffId}, CURRENT_TIMESTAMP, ${input.notes ?? null}, ${input.idempotencyKey})
    ON CONFLICT ("idempotencyKey") DO NOTHING
  `;
  const receipt = await tx.goodsReceipt.findUniqueOrThrow({ where: { idempotencyKey: input.idempotencyKey } });
  if (rowsInserted === 0) return { receipt, alreadyExisted: true as const };

  for (const line of input.lines) {
    if (line.acceptedQuantity < 0 || (line.rejectedQuantity ?? 0) < 0) throw new BadRequestError("Quantities cannot be negative.");
    await tx.goodsReceiptLine.create({
      data: {
        goodsReceiptId: receipt.id,
        purchaseOrderLineId: line.purchaseOrderLineId,
        itemId: line.itemId,
        lotNumber: line.lotNumber,
        manufacturer: line.manufacturer,
        manufacturedAt: line.manufacturedAt,
        expiresAt: line.expiresAt,
        acceptedQuantity: line.acceptedQuantity,
        rejectedQuantity: line.rejectedQuantity ?? 0,
        rejectionReason: line.rejectionReason,
        unitCostMinor: line.unitCostMinor,
        locationId: line.locationId,
        unit: line.unit,
      },
    });
  }

  return { receipt, alreadyExisted: false as const };
}

/**
 * Applies the stock effect: for each line, a ceiling-guarded raw UPDATE on
 * PurchaseOrderLine.receivedQuantity (`WHERE orderedQuantity -
 * receivedQuantity >= acceptedQuantity`) closes both the duplicate-receipt
 * race (#3) and the over-receipt rejection requirement in one atomic
 * statement — whichever of two concurrently-approved receipts against the
 * same line runs second re-evaluates the ceiling against the now-current
 * receivedQuantity and is atomically rejected if it would exceed
 * orderedQuantity. Rejected quantity never enters usable stock — only
 * acceptedQuantity is posted to the ledger/balance.
 */
export async function approveGoodsReceipt(tx: Tx, receiptId: string, input: { approvedByStaffId: string; actorUserId: string }) {
  const receipt = await tx.goodsReceipt.findUniqueOrThrow({ where: { id: receiptId }, include: { lines: true } });
  if (receipt.recordedByStaffId === input.approvedByStaffId) throw new SameActorApprovalError();

  const result = await tx.goodsReceipt.updateMany({
    where: { id: receiptId, status: "RECORDED" },
    data: { status: "APPROVED", approvedByStaffId: input.approvedByStaffId, approvedAt: new Date() },
  });
  if (result.count !== 1) throw new GoodsReceiptConcurrencyError(receipt.status);

  for (const line of receipt.lines) {
    if (line.acceptedQuantity <= 0) continue; // fully rejected line — nothing enters stock

    const ceilingResult = await tx.$executeRaw`
      UPDATE "PurchaseOrderLine" SET "receivedQuantity" = "receivedQuantity" + ${line.acceptedQuantity}
      WHERE id = ${line.purchaseOrderLineId} AND ("orderedQuantity" - "receivedQuantity") >= ${line.acceptedQuantity}
    `;
    if (Number(ceilingResult) !== 1) throw new OverReceiptError(line.purchaseOrderLineId);

    const lot = await getOrCreateLot(tx, {
      itemId: line.itemId,
      facilityId: receipt.facilityId,
      lotNumber: line.lotNumber,
      manufacturer: line.manufacturer,
      manufacturedAt: line.manufacturedAt,
      expiresAt: line.expiresAt,
    });
    // Phase B8 — establish the lot's acquisition cost on first receipt into it
    // (immutable thereafter; historical valuation is never rewritten when
    // supplier pricing later changes).
    if (line.unitCostMinor != null) {
      await tx.itemLot.updateMany({ where: { id: lot.id, unitCostMinor: null }, data: { unitCostMinor: line.unitCostMinor } });
    }
    const balance = await getOrCreateStockBalance(tx, { facilityId: receipt.facilityId, itemId: line.itemId, lotId: lot.id, locationId: line.locationId });
    await atomicIncrementOnHand(tx, balance.id, line.acceptedQuantity);
    await postLedgerEntry(tx, {
      facilityId: receipt.facilityId,
      itemId: line.itemId,
      lotId: lot.id,
      locationId: line.locationId,
      movementType: "RECEIPT",
      onHandDelta: line.acceptedQuantity,
      unit: line.unit,
      sourceType: "GoodsReceiptLine",
      sourceId: line.id,
      actorUserId: input.actorUserId,
      actorStaffId: input.approvedByStaffId,
    });
  }

  await recomputeReceivingStatus(tx, receipt.purchaseOrderId);
  return tx.goodsReceipt.findUniqueOrThrow({ where: { id: receiptId }, include: { lines: true } });
}

export async function rejectGoodsReceipt(tx: Tx, receiptId: string, input: { rejectedByStaffId: string; reason: string }) {
  const result = await tx.goodsReceipt.updateMany({
    where: { id: receiptId, status: "RECORDED" },
    data: { status: "REJECTED", rejectedByStaffId: input.rejectedByStaffId, rejectedAt: new Date(), rejectionReason: input.reason },
  });
  if (result.count !== 1) throw new GoodsReceiptConcurrencyError("not RECORDED");
  return tx.goodsReceipt.findUniqueOrThrow({ where: { id: receiptId } });
}

/** Convenience: allocates a receipt number when recording — kept separate from recordGoodsReceipt so the sequence isn't burned on an idempotent-retry no-op. Callers that want a numbered receipt call this once, right after a successful (alreadyExisted:false) recordGoodsReceipt. */
export async function assignGoodsReceiptNumber(tx: Tx, receiptId: string, facilityId: string) {
  const fiscalYear = new Date().getFullYear();
  const seq = await nextGoodsReceiptSequence(tx, { facilityId, fiscalYear });
  const receiptNumber = formatSequenceNumber("GRN", fiscalYear, seq);
  return tx.goodsReceipt.update({ where: { id: receiptId }, data: { receiptNumber } });
}
