import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { BadRequestError } from "@/lib/auth/rbac";

type Tx = Prisma.TransactionClient;

export class InsufficientStockError extends BadRequestError {
  constructor(available: number, requested: number) {
    super(`Insufficient available stock: ${available} available, ${requested} requested.`);
  }
}

export class InsufficientReservedError extends BadRequestError {
  constructor() {
    super("Cannot release/consume more than is currently reserved.");
  }
}

/**
 * The concurrency-critical core of this phase. StockBalance.onHandQty/
 * reservedQty are Float accumulators, not enum status columns — an
 * observed-value-equality CAS (`WHERE onHandQty = 5`) is the wrong tool
 * (fragile on floats, and the real guard needed is a THRESHOLD, not
 * equality). Every quantity mutation below is a single atomic conditional
 * UPDATE via $executeRaw (Prisma's fluent builder can't express a
 * column-to-column comparison like `onHandQty - reservedQty >= qty`) — one
 * SQL statement is simultaneously the read-check and the write, so there
 * is no read-then-write gap for a race to land in. A concurrent second
 * UPDATE targeting the same row blocks on the row lock, then re-evaluates
 * its own WHERE clause against the now-current row. Correct identically on
 * SQLite and Postgres; see docs/PHASE_6A_INTEGRITY.md for the full
 * justification and scripts/verify-postgres-inventory-concurrency.ts for
 * the genuine-parallel-race proof.
 */

export async function getOrCreateStockBalance(
  tx: Tx,
  input: { facilityId: string; itemId: string; lotId: string; locationId: string }
) {
  await tx.$executeRaw`
    INSERT INTO "StockBalance" (id, "facilityId", "itemId", "lotId", "locationId", "onHandQty", "reservedQty", "updatedAt")
    VALUES (${randomUUID()}, ${input.facilityId}, ${input.itemId}, ${input.lotId}, ${input.locationId}, 0, 0, CURRENT_TIMESTAMP)
    ON CONFLICT ("itemId", "lotId", "locationId") DO NOTHING
  `;
  return tx.stockBalance.findUniqueOrThrow({
    where: { itemId_lotId_locationId: { itemId: input.itemId, lotId: input.lotId, locationId: input.locationId } },
  });
}

export function computeAvailable(balance: { onHandQty: number; reservedQty: number }): number {
  return balance.onHandQty - balance.reservedQty;
}

/** Unconditional increment — always safe (no upper bound on how much stock can exist), used by RECEIPT/TRANSFER_IN/RETURN/positive ADJUSTMENT. Still one atomic UPDATE, so concurrent increments never clobber each other. */
export async function atomicIncrementOnHand(tx: Tx, balanceId: string, quantity: number): Promise<void> {
  await tx.$executeRaw`UPDATE "StockBalance" SET "onHandQty" = "onHandQty" + ${quantity}, "updatedAt" = CURRENT_TIMESTAMP WHERE id = ${balanceId}`;
}

/** Guarded decrement for ISSUE/TRANSFER_OUT/WASTE/negative ADJUSTMENT — fails atomically (0 rows affected) if available (onHand - reserved) is insufficient. Throws InsufficientStockError, never allows negative available. */
export async function atomicDecrementOnHand(tx: Tx, balanceId: string, quantity: number): Promise<void> {
  const result = await tx.$executeRaw`
    UPDATE "StockBalance" SET "onHandQty" = "onHandQty" - ${quantity}, "updatedAt" = CURRENT_TIMESTAMP
    WHERE id = ${balanceId} AND ("onHandQty" - "reservedQty") >= ${quantity}
  `;
  if (Number(result) !== 1) {
    const balance = await tx.stockBalance.findUniqueOrThrow({ where: { id: balanceId } });
    throw new InsufficientStockError(computeAvailable(balance), quantity);
  }
}

/** Guarded increment of reservedQty — a reservation is "reduce available by N," symmetric with issue, so it uses the identical threshold guard. */
export async function atomicIncrementReserved(tx: Tx, balanceId: string, quantity: number): Promise<void> {
  const result = await tx.$executeRaw`
    UPDATE "StockBalance" SET "reservedQty" = "reservedQty" + ${quantity}, "updatedAt" = CURRENT_TIMESTAMP
    WHERE id = ${balanceId} AND ("onHandQty" - "reservedQty") >= ${quantity}
  `;
  if (Number(result) !== 1) {
    const balance = await tx.stockBalance.findUniqueOrThrow({ where: { id: balanceId } });
    throw new InsufficientStockError(computeAvailable(balance), quantity);
  }
}

/** Guarded decrement of reservedQty (RELEASE — giving back a reservation without consuming it). Floor-guarded at 0, never negative. */
export async function atomicDecrementReserved(tx: Tx, balanceId: string, quantity: number): Promise<void> {
  const result = await tx.$executeRaw`
    UPDATE "StockBalance" SET "reservedQty" = "reservedQty" - ${quantity}, "updatedAt" = CURRENT_TIMESTAMP
    WHERE id = ${balanceId} AND "reservedQty" >= ${quantity}
  `;
  if (Number(result) !== 1) throw new InsufficientReservedError();
}

/** Consuming a reservation (RESERVATION -> ISSUE): decrements both onHandQty and reservedQty by the same amount in one atomic statement. Since the quantity was already carved out of "available" at reservation time, only reservedQty needs the floor guard here — onHand is guaranteed sufficient by construction (a reservation can never have exceeded onHand when it was created). */
export async function atomicConvertReservedToIssued(tx: Tx, balanceId: string, quantity: number): Promise<void> {
  const result = await tx.$executeRaw`
    UPDATE "StockBalance" SET "onHandQty" = "onHandQty" - ${quantity}, "reservedQty" = "reservedQty" - ${quantity}, "updatedAt" = CURRENT_TIMESTAMP
    WHERE id = ${balanceId} AND "reservedQty" >= ${quantity}
  `;
  if (Number(result) !== 1) throw new InsufficientReservedError();
}

/**
 * Reconciliation: the ledger is authoritative, the balance is a derivable
 * cache. Recomputes SUM(onHandDelta)/SUM(reservedDelta) grouped by
 * (itemId, lotId, locationId) from StockLedgerEntry and diffs against the
 * current StockBalance rows — surfaces any divergence rather than trusting
 * the cache blindly.
 */
export async function reconcileBalances(tx: Tx, facilityId: string) {
  const balances = await tx.stockBalance.findMany({ where: { facilityId } });
  const ledgerSums = await tx.stockLedgerEntry.groupBy({
    by: ["itemId", "lotId", "locationId"],
    where: { facilityId },
    _sum: { onHandDelta: true, reservedDelta: true },
  });
  const sumByKey = new Map(ledgerSums.map((s) => [`${s.itemId}:${s.lotId}:${s.locationId}`, s]));

  const discrepancies: Array<{ itemId: string; lotId: string; locationId: string; balanceOnHand: number; ledgerOnHand: number; balanceReserved: number; ledgerReserved: number }> = [];
  for (const balance of balances) {
    const key = `${balance.itemId}:${balance.lotId}:${balance.locationId}`;
    const sum = sumByKey.get(key);
    const ledgerOnHand = sum?._sum.onHandDelta ?? 0;
    const ledgerReserved = sum?._sum.reservedDelta ?? 0;
    if (Math.abs(ledgerOnHand - balance.onHandQty) > 1e-9 || Math.abs(ledgerReserved - balance.reservedQty) > 1e-9) {
      discrepancies.push({ itemId: balance.itemId, lotId: balance.lotId, locationId: balance.locationId, balanceOnHand: balance.onHandQty, ledgerOnHand, balanceReserved: balance.reservedQty, ledgerReserved });
    }
  }
  return { checked: balances.length, discrepancies };
}
