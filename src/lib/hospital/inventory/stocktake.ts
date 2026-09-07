import type { Prisma } from "@prisma/client";
import { BadRequestError } from "@/lib/auth/rbac";
import { createAdjustment } from "./adjustment";
import { assertItemInFacility, assertLocationInFacility, assertLotInFacility } from "./facilityScope";

type Tx = Prisma.TransactionClient;

export class StockTakeAlreadyInProgressError extends BadRequestError {
  constructor() {
    super("A stocktake is already in progress at this location — the DB-level partial unique index (stocktake_one_in_progress_per_location) blocked a second concurrent count.");
  }
}

function isUniqueConstraintError(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "P2002");
}

export class StockTakeNotInProgressError extends BadRequestError {
  constructor(status: string) {
    super(`Stocktake is not IN_PROGRESS (currently ${status}).`);
  }
}

/** Guarded by the partial unique index on (facilityId, locationId) WHERE status='IN_PROGRESS' — two concurrent starts for the same location leave exactly one IN_PROGRESS. */
export async function startStockTake(tx: Tx, input: { facilityId: string; locationId: string; startedByStaffId: string }) {
  await assertLocationInFacility(tx, input.locationId, input.facilityId);
  try {
    return await tx.stockTake.create({
      data: { facilityId: input.facilityId, locationId: input.locationId, status: "IN_PROGRESS", startedByStaffId: input.startedByStaffId, startedAt: new Date() },
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) throw new StockTakeAlreadyInProgressError();
    throw err;
  }
}

/** Snapshots systemQuantity at add-time — never re-read live at completion, so a variance always reflects "what the system said when this line was counted," not a moving target. */
export async function addStockTakeLine(tx: Tx, stockTakeId: string, input: { itemId: string; lotId: string; countedQuantity?: number }) {
  const stockTake = await tx.stockTake.findUniqueOrThrow({ where: { id: stockTakeId } });
  if (stockTake.status !== "IN_PROGRESS") throw new StockTakeNotInProgressError(stockTake.status);
  await assertItemInFacility(tx, input.itemId, stockTake.facilityId);
  await assertLotInFacility(tx, input.lotId, stockTake.facilityId);

  const balance = await tx.stockBalance.findFirst({ where: { itemId: input.itemId, lotId: input.lotId, locationId: stockTake.locationId } });
  const systemQuantity = balance?.onHandQty ?? 0;
  const varianceQuantity = input.countedQuantity != null ? input.countedQuantity - systemQuantity : null;

  return tx.stockTakeLine.upsert({
    where: { stockTakeId_itemId_lotId: { stockTakeId, itemId: input.itemId, lotId: input.lotId } },
    create: { stockTakeId, itemId: input.itemId, lotId: input.lotId, systemQuantity, countedQuantity: input.countedQuantity, varianceQuantity },
    update: { countedQuantity: input.countedQuantity, varianceQuantity },
  });
}

/** Never silently overwrites systemQuantity — creates one StockAdjustment per non-zero-variance line, which itself goes through the normal adjustment approval threshold. */
export async function completeStockTake(tx: Tx, stockTakeId: string, input: { completedByStaffId: string; actorUserId: string }) {
  const stockTake = await tx.stockTake.findUniqueOrThrow({ where: { id: stockTakeId }, include: { lines: true } });
  const result = await tx.stockTake.updateMany({
    where: { id: stockTakeId, status: "IN_PROGRESS" },
    data: { status: "COMPLETED", completedByStaffId: input.completedByStaffId, completedAt: new Date() },
  });
  if (result.count !== 1) throw new StockTakeNotInProgressError(stockTake.status);

  for (const line of stockTake.lines) {
    if (!line.varianceQuantity || line.varianceQuantity === 0) continue;
    const { adjustment } = await createAdjustment(tx, {
      facilityId: stockTake.facilityId,
      itemId: line.itemId,
      lotId: line.lotId,
      locationId: stockTake.locationId,
      quantityDelta: line.varianceQuantity,
      reason: "COUNT_CORRECTION",
      notes: `Stocktake ${stockTakeId} variance`,
      requestedByStaffId: input.completedByStaffId,
      actorUserId: input.actorUserId,
      sourceType: "StockTakeLine",
      sourceId: line.id,
      idempotencyKey: `stocktake-line-${line.id}`,
    });
    await tx.stockTakeLine.update({ where: { id: line.id }, data: { resultingAdjustmentId: adjustment.id } });
  }

  return tx.stockTake.findUniqueOrThrow({ where: { id: stockTakeId }, include: { lines: true } });
}
