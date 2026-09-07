import { randomUUID } from "node:crypto";
import { Prisma, type AdjustmentReason } from "@prisma/client";
import { BadRequestError } from "@/lib/auth/rbac";
import { getOrCreateStockBalance, atomicIncrementOnHand, atomicDecrementOnHand } from "./stockBalance";
import { postLedgerEntry } from "./ledger";
import { assertItemInFacility, assertLocationInFacility, assertLotInFacility } from "./facilityScope";

type Tx = Prisma.TransactionClient;

/** Any adjustment whose magnitude meets or exceeds this is high-impact and requires separate-actor approval before it touches stock. Deliberately a simple constant, not a per-item/per-facility policy — matches the brief's "keep procurement simple" instruction. */
export const HIGH_IMPACT_ADJUSTMENT_QTY_THRESHOLD = 50;

export class AdjustmentConcurrencyError extends BadRequestError {
  constructor(adjustmentId: string) {
    super(`Adjustment ${adjustmentId} is no longer in the expected state.`);
  }
}

export class SameActorApprovalError extends BadRequestError {
  constructor() {
    super("The same staff member cannot both request and approve a high-impact adjustment.");
  }
}

async function applySignedDelta(tx: Tx, balanceId: string, delta: number) {
  if (delta >= 0) await atomicIncrementOnHand(tx, balanceId, delta);
  else await atomicDecrementOnHand(tx, balanceId, -delta);
}

export interface CreateAdjustmentInput {
  facilityId: string;
  itemId: string;
  lotId: string;
  locationId: string;
  quantityDelta: number;
  reason: AdjustmentReason;
  notes?: string;
  requestedByStaffId: string;
  actorUserId: string;
  sourceType?: string;
  sourceId?: string;
  idempotencyKey: string;
}

/**
 * Normal-impact adjustments (|delta| < threshold) post immediately.
 * High-impact adjustments are recorded PENDING_APPROVAL with NO stock
 * effect yet — approveAdjustment applies the ledger/balance change,
 * gated by a guarded status CAS plus a same-actor guard (mirrors
 * billing/refunds.ts's requestedByUserId !== approvedByUserId check).
 * Insert-first idempotency, same reasoning as reservation.ts/transfer.ts.
 */
export async function createAdjustment(tx: Tx, input: CreateAdjustmentInput) {
  await assertItemInFacility(tx, input.itemId, input.facilityId);
  await assertLocationInFacility(tx, input.locationId, input.facilityId);
  await assertLotInFacility(tx, input.lotId, input.facilityId);

  const isHighImpact = Math.abs(input.quantityDelta) >= HIGH_IMPACT_ADJUSTMENT_QTY_THRESHOLD;
  const initialStatus = isHighImpact ? "PENDING_APPROVAL" : "POSTED";
  const id = randomUUID();

  const rowsInserted = await tx.$executeRaw`
    INSERT INTO "StockAdjustment"
      (id, "facilityId", "itemId", "lotId", "locationId", "quantityDelta", reason, notes, status, "requestedByStaffId", "sourceType", "sourceId", "idempotencyKey", "createdAt")
    VALUES
      (${id}, ${input.facilityId}, ${input.itemId}, ${input.lotId}, ${input.locationId}, ${input.quantityDelta}, ${Prisma.raw(`'${input.reason}'`)}, ${input.notes ?? null}, ${Prisma.raw(`'${initialStatus}'`)}, ${input.requestedByStaffId}, ${input.sourceType ?? null}, ${input.sourceId ?? null}, ${input.idempotencyKey}, CURRENT_TIMESTAMP)
    ON CONFLICT ("idempotencyKey") DO NOTHING
  `;
  const adjustment = await tx.stockAdjustment.findUniqueOrThrow({ where: { idempotencyKey: input.idempotencyKey } });
  if (rowsInserted === 0) return { adjustment, alreadyExisted: true as const };

  if (!isHighImpact) {
    const item = await tx.item.findUniqueOrThrow({ where: { id: input.itemId } });
    const balance = await getOrCreateStockBalance(tx, { facilityId: input.facilityId, itemId: input.itemId, lotId: input.lotId, locationId: input.locationId });
    await applySignedDelta(tx, balance.id, input.quantityDelta);
    await postLedgerEntry(tx, {
      facilityId: input.facilityId,
      itemId: input.itemId,
      lotId: input.lotId,
      locationId: input.locationId,
      movementType: "ADJUSTMENT",
      onHandDelta: input.quantityDelta,
      unit: item.baseUnit,
      adjustmentReason: input.reason,
      notes: input.notes,
      sourceType: "StockAdjustment",
      sourceId: adjustment.id,
      actorUserId: input.actorUserId,
      actorStaffId: input.requestedByStaffId,
    });
  }

  return { adjustment, alreadyExisted: false as const };
}

export async function approveAdjustment(tx: Tx, adjustmentId: string, input: { approvedByStaffId: string; actorUserId: string }) {
  const adjustment = await tx.stockAdjustment.findUniqueOrThrow({ where: { id: adjustmentId } });
  if (adjustment.requestedByStaffId === input.approvedByStaffId) throw new SameActorApprovalError();

  const result = await tx.stockAdjustment.updateMany({
    where: { id: adjustmentId, status: "PENDING_APPROVAL" },
    data: { status: "APPROVED", approvedByStaffId: input.approvedByStaffId, approvedAt: new Date() },
  });
  if (result.count !== 1) throw new AdjustmentConcurrencyError(adjustmentId);

  const item = await tx.item.findUniqueOrThrow({ where: { id: adjustment.itemId } });
  const balance = await getOrCreateStockBalance(tx, { facilityId: adjustment.facilityId, itemId: adjustment.itemId, lotId: adjustment.lotId, locationId: adjustment.locationId });
  await applySignedDelta(tx, balance.id, adjustment.quantityDelta);
  await postLedgerEntry(tx, {
    facilityId: adjustment.facilityId,
    itemId: adjustment.itemId,
    lotId: adjustment.lotId,
    locationId: adjustment.locationId,
    movementType: "ADJUSTMENT",
    onHandDelta: adjustment.quantityDelta,
    unit: item.baseUnit,
    adjustmentReason: adjustment.reason,
    notes: adjustment.notes,
    sourceType: "StockAdjustment",
    sourceId: adjustment.id,
    actorUserId: input.actorUserId,
    actorStaffId: input.approvedByStaffId,
  });

  return tx.stockAdjustment.findUniqueOrThrow({ where: { id: adjustmentId } });
}

export async function rejectAdjustment(tx: Tx, adjustmentId: string, input: { rejectionReason: string; actorUserId: string }) {
  const result = await tx.stockAdjustment.updateMany({
    where: { id: adjustmentId, status: "PENDING_APPROVAL" },
    data: { status: "REJECTED", rejectedAt: new Date(), rejectionReason: input.rejectionReason },
  });
  if (result.count !== 1) throw new AdjustmentConcurrencyError(adjustmentId);
  return tx.stockAdjustment.findUniqueOrThrow({ where: { id: adjustmentId } });
}
