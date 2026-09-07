import { randomUUID } from "node:crypto";
import { Prisma, type WasteReason } from "@prisma/client";
import { BadRequestError } from "@/lib/auth/rbac";
import { getOrCreateStockBalance, atomicDecrementOnHand } from "./stockBalance";
import { postLedgerEntry } from "./ledger";
import { assertItemInFacility, assertLocationInFacility, assertLotInFacility } from "./facilityScope";

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
    ON CONFLICT ("idempotencyKey") DO NOTHING
  `;
  const waste = await tx.wasteRecord.findUniqueOrThrow({ where: { idempotencyKey: input.idempotencyKey } });
  if (rowsInserted === 0) return { waste, alreadyExisted: true as const };

  if (!isHighValue) {
    await applyWasteToStock(tx, waste, input.actorUserId, input.requestedByStaffId);
  }

  return { waste, alreadyExisted: false as const };
}

async function applyWasteToStock(tx: Tx, waste: { id: string; facilityId: string; itemId: string; lotId: string; locationId: string; quantity: number; reason: WasteReason; patientId: string | null; encounterId: string | null }, actorUserId: string, actorStaffId?: string) {
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

  await applyWasteToStock(tx, waste, input.actorUserId, input.approvedByStaffId);
  return tx.wasteRecord.findUniqueOrThrow({ where: { id: wasteId } });
}

export async function rejectWaste(tx: Tx, wasteId: string) {
  const result = await tx.wasteRecord.updateMany({ where: { id: wasteId, status: "PENDING_APPROVAL" }, data: { status: "REJECTED" } });
  if (result.count !== 1) throw new WasteConcurrencyError(wasteId);
  return tx.wasteRecord.findUniqueOrThrow({ where: { id: wasteId } });
}
