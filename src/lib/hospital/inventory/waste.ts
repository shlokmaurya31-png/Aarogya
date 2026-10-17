import { randomUUID } from "node:crypto";
import { Prisma, type WasteReason } from "@prisma/client";
import { BadRequestError } from "@/lib/auth/rbac";
import { getOrCreateStockBalance, atomicDecrementOnHand, atomicIncrementReserved, atomicDecrementReserved, atomicConvertReservedToIssued } from "./stockBalance";
import { postLedgerEntry } from "./ledger";
import { emitStockDocumentStatus } from "./stockDocumentEvent";
import { assertItemInFacility, assertLocationInFacility, assertLotInFacility, assertReplayInFacility } from "./facilityScope";

type Tx = Prisma.TransactionClient;

/** No item cost/valuation model exists this phase (see docs/PHASE_6A_INTEGRITY.md scope cuts), so "high-value" waste is approximated by quantity, exactly like adjustment.ts's threshold — a documented simplification, not a silent one. */
export const HIGH_VALUE_WASTE_QTY_THRESHOLD = 50;

export class WasteConcurrencyError extends BadRequestError {
  constructor(wasteId: string) {
    super(`Waste record ${wasteId} is no longer in the expected state.`);
  }
}

export class SameActorApprovalError extends BadRequestError {
  constructor() {
    super("The same staff member cannot both request and approve high-value waste.");
  }
}

export interface RecordWasteInput {
  facilityId: string;
  itemId: string;
  lotId: string;
  locationId: string;
  quantity: number;
  reason: WasteReason;
  notes?: string;
  patientId?: string;
  encounterId?: string;
  requestedByStaffId: string;
  actorUserId: string;
  idempotencyKey: string;
}

/** Its own ledger movement type — never an invisible decrement. Normal-value waste posts immediately (guarded floor decrement); high-value waste is PENDING_APPROVAL with no stock effect until approveWaste. Insert-first idempotency, same reasoning as reservation.ts. */
export async function recordWaste(tx: Tx, input: RecordWasteInput) {
  if (input.quantity <= 0) throw new BadRequestError("Waste quantity must be positive.");
  await assertItemInFacility(tx, input.itemId, input.facilityId);
  await assertLocationInFacility(tx, input.locationId, input.facilityId);
  await assertLotInFacility(tx, input.lotId, input.facilityId);

  const isHighValue = input.quantity >= HIGH_VALUE_WASTE_QTY_THRESHOLD;
  const initialStatus = isHighValue ? "PENDING_APPROVAL" : "POSTED";
  const id = randomUUID();

  const rowsInserted = await tx.$executeRaw`
    INSERT INTO "WasteRecord"
      (id, "facilityId", "itemId", "lotId", "locationId", quantity, reason, status, "patientId", "encounterId", "requestedByStaffId", notes, "idempotencyKey", "createdAt")
    VALUES
      (${id}, ${input.facilityId}, ${input.itemId}, ${input.lotId}, ${input.locationId}, ${input.quantity}, ${Prisma.raw(`'${input.reason}'`)}, ${Prisma.raw(`'${initialStatus}'`)}, ${input.patientId ?? null}, ${input.encounterId ?? null}, ${input.requestedByStaffId}, ${input.notes ?? null}, ${input.idempotencyKey}, CURRENT_TIMESTAMP)
    ON CONFLICT ("facilityId", "idempotencyKey") DO NOTHING
  `;
  const waste = assertReplayInFacility(await tx.wasteRecord.findUniqueOrThrow({ where: { facilityId_idempotencyKey: { facilityId: input.facilityId, idempotencyKey: input.idempotencyKey } } }), input.facilityId);
  if (rowsInserted === 0) return { waste, alreadyExisted: true as const };

  if (!isHighValue) {
    await applyWasteToStock(tx, waste, input.actorUserId, input.requestedByStaffId);
  } else {
    // Approved change 4 (step 9a): awaiting approval, the quantity is HELD
    // (reserved against this waste record: unavailable, not written off).
    await moveHold(tx, waste, "HOLD", input.actorUserId, input.requestedByStaffId);
  }

  return { waste, alreadyExisted: false as const };
}

type WasteRow = { id: string; facilityId: string; itemId: string; lotId: string; locationId: string; quantity: number; reason: WasteReason; patientId: string | null; encounterId: string | null };

/** Whether this waste's quantity was put on HOLD when it was recorded (records from before step 9a were not). */
async function isHeld(tx: Tx, wasteId: string) {
  return (await tx.stockLedgerEntry.count({ where: { sourceType: "WasteRecord", sourceId: wasteId, movementType: "RESERVATION" } })) > 0;
}

/**
 * The HOLD's three moves, each a new ledger entry (never an edit): HOLD
 * reserves the quantity, WRITE_OFF takes it from the hold off the books,
 * RETURN releases it back to available stock.
 */
async function moveHold(tx: Tx, waste: WasteRow, move: "HOLD" | "WRITE_OFF" | "RETURN", actorUserId: string, actorStaffId?: string) {
  const item = await tx.item.findUniqueOrThrow({ where: { id: waste.itemId } });
  const balance = await getOrCreateStockBalance(tx, { facilityId: waste.facilityId, itemId: waste.itemId, lotId: waste.lotId, locationId: waste.locationId });
  const q = waste.quantity;
  if (move === "HOLD") await atomicIncrementReserved(tx, balance.id, q);
  else if (move === "WRITE_OFF") await atomicConvertReservedToIssued(tx, balance.id, q);
  else await atomicDecrementReserved(tx, balance.id, q);
  await postLedgerEntry(tx, {
    facilityId: waste.facilityId, itemId: waste.itemId, lotId: waste.lotId, locationId: waste.locationId,
    movementType: move === "HOLD" ? "RESERVATION" : move === "WRITE_OFF" ? "WASTE" : "RELEASE",
    onHandDelta: move === "WRITE_OFF" ? -q : 0, reservedDelta: move === "HOLD" ? q : -q,
    unit: item.baseUnit, wasteReason: move === "RETURN" ? null : waste.reason,
    patientId: waste.patientId ?? undefined, encounterId: waste.encounterId ?? undefined,
    sourceType: "WasteRecord", sourceId: waste.id, actorUserId, actorStaffId,
  });
}

async function applyWasteToStock(tx: Tx, waste: WasteRow, actorUserId: string, actorStaffId?: string) {
  const item = await tx.item.findUniqueOrThrow({ where: { id: waste.itemId } });
  const balance = await getOrCreateStockBalance(tx, { facilityId: waste.facilityId, itemId: waste.itemId, lotId: waste.lotId, locationId: waste.locationId });
  await atomicDecrementOnHand(tx, balance.id, waste.quantity);
  await postLedgerEntry(tx, {
    facilityId: waste.facilityId,
    itemId: waste.itemId,
    lotId: waste.lotId,
    locationId: waste.locationId,
    movementType: "WASTE",
    onHandDelta: -waste.quantity,
    unit: item.baseUnit,
    wasteReason: waste.reason,
    patientId: waste.patientId ?? undefined,
    encounterId: waste.encounterId ?? undefined,
    sourceType: "WasteRecord",
    sourceId: waste.id,
    actorUserId,
    actorStaffId,
  });
}

export async function approveWaste(tx: Tx, wasteId: string, input: { approvedByStaffId: string; actorUserId: string }) {
  const waste = await tx.wasteRecord.findUniqueOrThrow({ where: { id: wasteId } });
  if (waste.requestedByStaffId === input.approvedByStaffId) throw new SameActorApprovalError();

  const result = await tx.wasteRecord.updateMany({
    where: { id: wasteId, status: "PENDING_APPROVAL" },
    data: { status: "APPROVED", approvedByStaffId: input.approvedByStaffId, approvedAt: new Date() },
  });
  if (result.count !== 1) throw new WasteConcurrencyError(wasteId);

  // Written off from the HOLD; a pending waste recorded before step 9a has no
  // hold and is written off from available stock, as it always was.
  if (await isHeld(tx, waste.id)) await moveHold(tx, waste, "WRITE_OFF", input.actorUserId, input.approvedByStaffId);
  else await applyWasteToStock(tx, waste, input.actorUserId, input.approvedByStaffId);
  await emitStockDocumentStatus(tx, {
    documentType: "WASTE", documentId: waste.id, facilityId: waste.facilityId, from: "PENDING_APPROVAL", to: "APPROVED",
    itemId: waste.itemId, locationId: waste.locationId, actorUserId: input.actorUserId,
  });
  return tx.wasteRecord.findUniqueOrThrow({ where: { id: wasteId } });
}

/** A rejected waste returns its HOLD to available stock (a pre-9a record held nothing, so nothing returns). */
export async function rejectWaste(tx: Tx, wasteId: string, input: { actorUserId: string; rejectedByStaffId?: string }) {
  const waste = await tx.wasteRecord.findUniqueOrThrow({ where: { id: wasteId } });
  const result = await tx.wasteRecord.updateMany({ where: { id: wasteId, status: "PENDING_APPROVAL" }, data: { status: "REJECTED" } });
  if (result.count !== 1) throw new WasteConcurrencyError(wasteId);
  if (await isHeld(tx, waste.id)) await moveHold(tx, waste, "RETURN", input.actorUserId, input.rejectedByStaffId);
  await emitStockDocumentStatus(tx, {
    documentType: "WASTE", documentId: waste.id, facilityId: waste.facilityId, from: "PENDING_APPROVAL", to: "REJECTED",
    itemId: waste.itemId, locationId: waste.locationId, actorUserId: input.actorUserId,
  });
  return tx.wasteRecord.findUniqueOrThrow({ where: { id: wasteId } });
}
