import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { BadRequestError } from "@/lib/auth/rbac";
import { validateExplicitLot } from "./fefo";
import { getOrCreateStockBalance, atomicDecrementOnHand, atomicIncrementOnHand } from "./stockBalance";
import { postLedgerEntry } from "./ledger";
import { assertItemInFacility, assertLocationInFacility, assertLotInFacility } from "./facilityScope";

type Tx = Prisma.TransactionClient;

export class TransferConcurrencyError extends BadRequestError {
  constructor(transferId: string) {
    super(`Transfer ${transferId} was already received or cancelled, or is no longer in the expected state.`);
  }
}

export interface InitiateTransferInput {
  facilityId: string;
  itemId: string;
  lotId: string;
  fromLocationId: string;
  toLocationId: string;
  quantity: number;
  requestedByStaffId: string;
  actorUserId: string;
  reason?: string;
  idempotencyKey: string;
}

/**
 * Same facility only this phase. Stock leaves the source location the
 * moment the transfer is initiated (TRANSFER_OUT posted immediately, not
 * deferred to receipt) — same atomic conditional-decrement primitive as
 * issueStock, since a transfer consumes source-location availability
 * exactly like an issue does. Insert-first idempotency, same reasoning as
 * reservation.ts (a genuine concurrent double-submit with the same key
 * must not double-decrement the source).
 */
export async function initiateTransfer(tx: Tx, input: InitiateTransferInput) {
  if (input.fromLocationId === input.toLocationId) throw new BadRequestError("Source and destination location must differ.");
  await assertItemInFacility(tx, input.itemId, input.facilityId);
  await assertLocationInFacility(tx, input.fromLocationId, input.facilityId);
  await assertLocationInFacility(tx, input.toLocationId, input.facilityId);
  await assertLotInFacility(tx, input.lotId, input.facilityId);
  await validateExplicitLot(tx, input.lotId);

  const id = randomUUID();
  const rowsInserted = await tx.$executeRaw`
    INSERT INTO "StockTransfer"
      (id, "facilityId", "itemId", "lotId", "fromLocationId", "toLocationId", quantity, status, reason, "requestedByStaffId", "initiatedAt", "idempotencyKey", "createdAt")
    VALUES
      (${id}, ${input.facilityId}, ${input.itemId}, ${input.lotId}, ${input.fromLocationId}, ${input.toLocationId}, ${input.quantity}, ${Prisma.raw("'IN_TRANSIT'")}, ${input.reason ?? null}, ${input.requestedByStaffId}, CURRENT_TIMESTAMP, ${input.idempotencyKey}, CURRENT_TIMESTAMP)
    ON CONFLICT ("idempotencyKey") DO NOTHING
  `;
  const transfer = await tx.stockTransfer.findUniqueOrThrow({ where: { idempotencyKey: input.idempotencyKey } });
  if (rowsInserted === 0) return { transfer, alreadyExisted: true as const };

  const item = await tx.item.findUniqueOrThrow({ where: { id: input.itemId } });
  const sourceBalance = await getOrCreateStockBalance(tx, { facilityId: input.facilityId, itemId: input.itemId, lotId: input.lotId, locationId: input.fromLocationId });
  await atomicDecrementOnHand(tx, sourceBalance.id, input.quantity);
  await postLedgerEntry(tx, {
    facilityId: input.facilityId,
    itemId: input.itemId,
    lotId: input.lotId,
    locationId: input.fromLocationId,
    movementType: "TRANSFER_OUT",
    onHandDelta: -input.quantity,
    unit: item.baseUnit,
    reason: input.reason,
    movementGroupId: transfer.id,
    sourceType: "StockTransfer",
    sourceId: transfer.id,
    actorUserId: input.actorUserId,
    actorStaffId: input.requestedByStaffId,
  });

  return { transfer, alreadyExisted: false as const };
}

/** Guarded status CAS closes the duplicate-transfer-receipt race (#5) — the standard bed.ts/appointment.ts idiom, no raw SQL needed since this is a pure enum-status race. */
export async function receiveTransfer(tx: Tx, transferId: string, input: { receivedByStaffId: string; actorUserId: string }) {
  const transfer = await tx.stockTransfer.findUniqueOrThrow({ where: { id: transferId } });
  const result = await tx.stockTransfer.updateMany({
    where: { id: transferId, status: "IN_TRANSIT" },
    data: { status: "RECEIVED", receivedByStaffId: input.receivedByStaffId, receivedAt: new Date() },
  });
  if (result.count !== 1) throw new TransferConcurrencyError(transferId);

  const item = await tx.item.findUniqueOrThrow({ where: { id: transfer.itemId } });
  const destBalance = await getOrCreateStockBalance(tx, { facilityId: transfer.facilityId, itemId: transfer.itemId, lotId: transfer.lotId, locationId: transfer.toLocationId });
  await atomicIncrementOnHand(tx, destBalance.id, transfer.quantity);
  await postLedgerEntry(tx, {
    facilityId: transfer.facilityId,
    itemId: transfer.itemId,
    lotId: transfer.lotId,
    locationId: transfer.toLocationId,
    movementType: "TRANSFER_IN",
    onHandDelta: transfer.quantity,
    unit: item.baseUnit,
    movementGroupId: transfer.id,
    sourceType: "StockTransfer",
    sourceId: transfer.id,
    actorUserId: input.actorUserId,
    actorStaffId: input.receivedByStaffId,
  });

  return tx.stockTransfer.findUniqueOrThrow({ where: { id: transferId } });
}

/** Cancels an in-transit transfer, returning stock to the source (compensating increment — the original TRANSFER_OUT ledger row is never rewritten). */
export async function cancelTransfer(tx: Tx, transferId: string, input: { reason: string; actorUserId: string }) {
  const transfer = await tx.stockTransfer.findUniqueOrThrow({ where: { id: transferId } });
  const result = await tx.stockTransfer.updateMany({
    where: { id: transferId, status: "IN_TRANSIT" },
    data: { status: "CANCELLED", cancelledAt: new Date(), cancelledReason: input.reason },
  });
  if (result.count !== 1) throw new TransferConcurrencyError(transferId);

  const item = await tx.item.findUniqueOrThrow({ where: { id: transfer.itemId } });
  const sourceBalance = await getOrCreateStockBalance(tx, { facilityId: transfer.facilityId, itemId: transfer.itemId, lotId: transfer.lotId, locationId: transfer.fromLocationId });
  await atomicIncrementOnHand(tx, sourceBalance.id, transfer.quantity);
  await postLedgerEntry(tx, {
    facilityId: transfer.facilityId,
    itemId: transfer.itemId,
    lotId: transfer.lotId,
    locationId: transfer.fromLocationId,
    movementType: "RETURN",
    onHandDelta: transfer.quantity,
    unit: item.baseUnit,
    reason: `Transfer cancelled: ${input.reason}`,
    movementGroupId: transfer.id,
    sourceType: "StockTransfer",
    sourceId: transfer.id,
    actorUserId: input.actorUserId,
  });

  return tx.stockTransfer.findUniqueOrThrow({ where: { id: transferId } });
}
