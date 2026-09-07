import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { selectFefoLot, validateExplicitLot } from "./fefo";
import { getOrCreateStockBalance, atomicIncrementReserved, atomicDecrementReserved, atomicConvertReservedToIssued } from "./stockBalance";
import { postLedgerEntry } from "./ledger";
import { assertItemInFacility, assertLocationInFacility, assertLotInFacility } from "./facilityScope";

type Tx = Prisma.TransactionClient;

export interface ReserveStockInput {
  facilityId: string;
  itemId: string;
  locationId: string;
  quantity: number;
  lotId?: string; // explicit override; omitted => FEFO
  reservedForType?: string;
  reservedForId?: string;
  patientId?: string;
  encounterId?: string;
  requestedByStaffId: string;
  actorUserId: string;
  expiresAt?: Date;
  idempotencyKey: string;
}

/**
 * Reserves stock ahead of consumption. Uses the insert-first idempotency
 * pattern (unlike issue.ts's check-first pattern): the StockReservation
 * row's idempotencyKey is claimed via raw INSERT ... ON CONFLICT DO
 * NOTHING BEFORE the balance is touched, so a genuine concurrent
 * double-submit with the same key only lets ONE caller past the "did I
 * win the insert" gate — the loser reads back the winner's row and never
 * calls atomicIncrementReserved a second time. This is required here
 * (unlike issue.ts) because idempotencyKey is a real client-supplied,
 * retry-stable key that a genuine concurrent double-submit race can
 * target — exactly race #2 in the required concurrency matrix.
 */
export async function reserveStock(tx: Tx, input: ReserveStockInput) {
  await assertItemInFacility(tx, input.itemId, input.facilityId);
  await assertLocationInFacility(tx, input.locationId, input.facilityId);
  if (input.lotId) await assertLotInFacility(tx, input.lotId, input.facilityId);

  const lotId = input.lotId ?? (await selectFefoLot(tx, { itemId: input.itemId, locationId: input.locationId, quantity: input.quantity })).lotId;
  await validateExplicitLot(tx, lotId);

  const id = randomUUID();
  const rowsInserted = await tx.$executeRaw`
    INSERT INTO "StockReservation"
      (id, "facilityId", "itemId", "lotId", "locationId", quantity, status, "reservedForType", "reservedForId", "patientId", "encounterId", "requestedByStaffId", "expiresAt", "idempotencyKey", "createdAt")
    VALUES
      (${id}, ${input.facilityId}, ${input.itemId}, ${lotId}, ${input.locationId}, ${input.quantity}, ${Prisma.raw("'ACTIVE'")}, ${input.reservedForType ?? null}, ${input.reservedForId ?? null}, ${input.patientId ?? null}, ${input.encounterId ?? null}, ${input.requestedByStaffId}, ${input.expiresAt ?? null}, ${input.idempotencyKey}, CURRENT_TIMESTAMP)
    ON CONFLICT ("idempotencyKey") DO NOTHING
  `;
  const reservation = await tx.stockReservation.findUniqueOrThrow({ where: { idempotencyKey: input.idempotencyKey } });
  if (rowsInserted === 0) return { reservation, alreadyExisted: true as const };

  const item = await tx.item.findUniqueOrThrow({ where: { id: input.itemId } });
  const balance = await getOrCreateStockBalance(tx, { facilityId: input.facilityId, itemId: input.itemId, lotId, locationId: input.locationId });
  await atomicIncrementReserved(tx, balance.id, input.quantity);
  await postLedgerEntry(tx, {
    facilityId: input.facilityId,
    itemId: input.itemId,
    lotId,
    locationId: input.locationId,
    movementType: "RESERVATION",
    reservedDelta: input.quantity,
    unit: item.baseUnit,
    patientId: input.patientId,
    encounterId: input.encounterId,
    sourceType: "StockReservation",
    sourceId: reservation.id,
    actorUserId: input.actorUserId,
    actorStaffId: input.requestedByStaffId,
  });

  return { reservation, alreadyExisted: false as const };
}

export class ReservationNotActiveError extends Error {
  constructor(status: string) {
    super(`Reservation is not ACTIVE (currently ${status}) — cannot release or consume.`);
  }
}

/** Releases a reservation without consuming it — gives the quantity back to available. */
export async function releaseReservation(tx: Tx, reservationId: string, input: { byUserId: string }) {
  const reservation = await tx.stockReservation.findUniqueOrThrow({ where: { id: reservationId } });
  if (reservation.status !== "ACTIVE") throw new ReservationNotActiveError(reservation.status);

  const result = await tx.stockReservation.updateMany({
    where: { id: reservationId, status: "ACTIVE" },
    data: { status: "RELEASED", releasedAt: new Date(), releasedByUserId: input.byUserId },
  });
  if (result.count !== 1) throw new ReservationNotActiveError("ACTIVE");

  const item = await tx.item.findUniqueOrThrow({ where: { id: reservation.itemId } });
  const balance = await tx.stockBalance.findFirstOrThrow({ where: { itemId: reservation.itemId, lotId: reservation.lotId, locationId: reservation.locationId } });
  await atomicDecrementReserved(tx, balance.id, reservation.quantity);
  await postLedgerEntry(tx, {
    facilityId: reservation.facilityId,
    itemId: reservation.itemId,
    lotId: reservation.lotId,
    locationId: reservation.locationId,
    movementType: "RELEASE",
    reservedDelta: -reservation.quantity,
    unit: item.baseUnit,
    patientId: reservation.patientId,
    encounterId: reservation.encounterId,
    sourceType: "StockReservation",
    sourceId: reservation.id,
    actorUserId: input.byUserId,
  });

  return tx.stockReservation.findUniqueOrThrow({ where: { id: reservationId } });
}

/** Converts an ACTIVE reservation into an actual issue (e.g. an OT case that consumes what it reserved). */
export async function consumeReservation(tx: Tx, reservationId: string, input: { actorUserId: string; sourceType: string; sourceId: string; reason?: string }) {
  const reservation = await tx.stockReservation.findUniqueOrThrow({ where: { id: reservationId } });
  if (reservation.status !== "ACTIVE") throw new ReservationNotActiveError(reservation.status);

  const result = await tx.stockReservation.updateMany({ where: { id: reservationId, status: "ACTIVE" }, data: { status: "CONSUMED" } });
  if (result.count !== 1) throw new ReservationNotActiveError("ACTIVE");

  const item = await tx.item.findUniqueOrThrow({ where: { id: reservation.itemId } });
  const balance = await tx.stockBalance.findFirstOrThrow({ where: { itemId: reservation.itemId, lotId: reservation.lotId, locationId: reservation.locationId } });
  await atomicConvertReservedToIssued(tx, balance.id, reservation.quantity);
  await postLedgerEntry(tx, {
    facilityId: reservation.facilityId,
    itemId: reservation.itemId,
    lotId: reservation.lotId,
    locationId: reservation.locationId,
    movementType: "ISSUE",
    onHandDelta: -reservation.quantity,
    reservedDelta: -reservation.quantity,
    unit: item.baseUnit,
    reason: input.reason,
    patientId: reservation.patientId,
    encounterId: reservation.encounterId,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    actorUserId: input.actorUserId,
  });

  return tx.stockReservation.findUniqueOrThrow({ where: { id: reservationId } });
}
