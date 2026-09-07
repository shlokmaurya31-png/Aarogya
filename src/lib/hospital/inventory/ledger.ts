import { randomUUID } from "node:crypto";
import { Prisma, type StockMovementType, type UnitOfMeasure, type WasteReason, type AdjustmentReason } from "@prisma/client";

type Tx = Prisma.TransactionClient;

export interface PostLedgerEntryInput {
  facilityId: string;
  itemId: string;
  lotId: string;
  locationId: string;
  movementType: StockMovementType;
  onHandDelta?: number;
  reservedDelta?: number;
  unit: UnitOfMeasure;
  wasteReason?: WasteReason | null;
  adjustmentReason?: AdjustmentReason | null;
  reason?: string | null;
  notes?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  movementGroupId?: string | null;
  patientId?: string | null;
  encounterId?: string | null;
  actorUserId: string;
  actorStaffId?: string | null;
}

/**
 * The ONE function every stock-affecting service calls to write history.
 * Idempotent via raw INSERT ... ON CONFLICT (sourceType, sourceId,
 * movementType) DO NOTHING — the exact cross-engine idiom as
 * chargeCapture.ts#createChargeIfNotExists, for the same reason (a failed
 * INSERT inside an interactive transaction aborts the whole transaction on
 * Postgres; createMany+skipDuplicates isn't supported on SQLite at all).
 * `movementType`/`unit`/`wasteReason`/`adjustmentReason` are native
 * Postgres enum columns — injected as raw literals via Prisma.raw(), not
 * `${}` bind parameters, because Postgres won't implicitly cast a bound
 * text parameter to a custom enum type (only unqualified string literals
 * get that cast) — see billing/payments.ts#recordPayment for the proven
 * precedent. Safe here because every enum value passed in is a closed
 * TypeScript enum type, never free-text user input.
 *
 * StockLedgerEntry rows are NEVER updated or deleted anywhere in this
 * codebase after being posted — a correction is always a new, opposite-
 * direction entry (e.g. an erroneous ISSUE is corrected via a RETURN).
 */
export async function postLedgerEntry(tx: Tx, input: PostLedgerEntryInput): Promise<{ alreadyExisted: boolean }> {
  const enumLit = (value: string | null | undefined) => Prisma.raw(value ? `'${value}'` : "NULL");

  if (input.sourceType && input.sourceId) {
    const rowsInserted = await tx.$executeRaw`
      INSERT INTO "StockLedgerEntry"
        (id, "facilityId", "itemId", "lotId", "locationId", "movementType", "onHandDelta", "reservedDelta", unit, "wasteReason", "adjustmentReason", reason, notes, "sourceType", "sourceId", "movementGroupId", "patientId", "encounterId", "actorUserId", "actorStaffId", "postedAt")
      VALUES
        (${randomUUID()}, ${input.facilityId}, ${input.itemId}, ${input.lotId}, ${input.locationId}, ${enumLit(input.movementType)}, ${input.onHandDelta ?? 0}, ${input.reservedDelta ?? 0}, ${enumLit(input.unit)}, ${enumLit(input.wasteReason)}, ${enumLit(input.adjustmentReason)}, ${input.reason ?? null}, ${input.notes ?? null}, ${input.sourceType}, ${input.sourceId}, ${input.movementGroupId ?? null}, ${input.patientId ?? null}, ${input.encounterId ?? null}, ${input.actorUserId}, ${input.actorStaffId ?? null}, CURRENT_TIMESTAMP)
      ON CONFLICT ("sourceType", "sourceId", "movementType") DO NOTHING
    `;
    return { alreadyExisted: rowsInserted === 0 };
  }

  // No provenance key supplied (e.g. a one-off manual correction with no
  // single clinical/procurement source event) — idempotency doesn't apply,
  // a plain insert is correct and unambiguous.
  await tx.stockLedgerEntry.create({
    data: {
      facilityId: input.facilityId,
      itemId: input.itemId,
      lotId: input.lotId,
      locationId: input.locationId,
      movementType: input.movementType,
      onHandDelta: input.onHandDelta ?? 0,
      reservedDelta: input.reservedDelta ?? 0,
      unit: input.unit,
      wasteReason: input.wasteReason ?? null,
      adjustmentReason: input.adjustmentReason ?? null,
      reason: input.reason ?? null,
      notes: input.notes ?? null,
      movementGroupId: input.movementGroupId ?? null,
      patientId: input.patientId ?? null,
      encounterId: input.encounterId ?? null,
      actorUserId: input.actorUserId,
      actorStaffId: input.actorStaffId ?? null,
    },
  });
  return { alreadyExisted: false };
}
