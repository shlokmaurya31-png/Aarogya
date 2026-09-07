import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { BadRequestError } from "@/lib/auth/rbac";

type Tx = Prisma.TransactionClient;

const NO_LOT_NUMBER = "NO-LOT";

export class LotConcurrencyError extends BadRequestError {
  constructor(lotId: string) {
    super(`Lot ${lotId} was changed by someone else, or is no longer in the expected state. Refresh and try again.`);
  }
}

/**
 * Idempotent get-or-create keyed on the real @@unique([itemId, facilityId,
 * lotNumber]) constraint — raw INSERT ... ON CONFLICT DO NOTHING, the same
 * cross-engine idiom as chargeCapture.ts#createChargeIfNotExists, so two
 * concurrent goods receipts recording the same lot number never create two
 * lot rows.
 */
export async function getOrCreateLot(
  tx: Tx,
  input: { itemId: string; facilityId: string; lotNumber: string; manufacturer?: string | null; manufacturedAt?: Date | null; expiresAt?: Date | null }
) {
  await tx.$executeRaw`
    INSERT INTO "ItemLot" (id, "itemId", "facilityId", "lotNumber", manufacturer, "manufacturedAt", "expiresAt", status, "createdAt")
    VALUES (${randomUUID()}, ${input.itemId}, ${input.facilityId}, ${input.lotNumber}, ${input.manufacturer ?? null}, ${input.manufacturedAt ?? null}, ${input.expiresAt ?? null}, 'ACTIVE', CURRENT_TIMESTAMP)
    ON CONFLICT ("itemId", "facilityId", "lotNumber") DO NOTHING
  `;
  return tx.itemLot.findUniqueOrThrow({
    where: { itemId_facilityId_lotNumber: { itemId: input.itemId, facilityId: input.facilityId, lotNumber: input.lotNumber } },
  });
}

/** For trackLots=false items — every stock row still needs a non-null lotId, so a sentinel "NO-LOT" (never expires) is get-or-created rather than branching the whole stock model on nullable lotId. */
export async function getOrCreateNoLotSentinel(tx: Tx, itemId: string, facilityId: string) {
  return getOrCreateLot(tx, { itemId, facilityId, lotNumber: NO_LOT_NUMBER });
}

/** Lazy ACTIVE -> EXPIRED flip, called by every stock-affecting service before checking issuability — no cron exists in this codebase, so expiry state is corrected on read, backstopped by an admin-triggered manual sweep route for dashboards. */
export async function ensureLotExpiryState(tx: Tx, lotId: string) {
  const lot = await tx.itemLot.findUniqueOrThrow({ where: { id: lotId } });
  if (lot.status === "ACTIVE" && lot.expiresAt && lot.expiresAt.getTime() <= Date.now()) {
    await tx.itemLot.updateMany({ where: { id: lotId, status: "ACTIVE" }, data: { status: "EXPIRED" } });
    return tx.itemLot.findUniqueOrThrow({ where: { id: lotId } });
  }
  return lot;
}

export async function quarantineLot(tx: Tx, lotId: string, input: { reason: string; byUserId: string }) {
  const lot = await tx.itemLot.findUniqueOrThrow({ where: { id: lotId } });
  const result = await tx.itemLot.updateMany({
    where: { id: lotId, status: lot.status },
    data: { status: "QUARANTINED", quarantineReason: input.reason, quarantinedAt: new Date(), quarantinedByUserId: input.byUserId },
  });
  if (result.count !== 1) throw new LotConcurrencyError(lotId);
  return tx.itemLot.findUniqueOrThrow({ where: { id: lotId } });
}

export async function releaseLotFromQuarantine(tx: Tx, lotId: string, input: { byUserId: string }) {
  const result = await tx.itemLot.updateMany({
    where: { id: lotId, status: "QUARANTINED" },
    data: { status: "ACTIVE", releasedAt: new Date(), releasedByUserId: input.byUserId },
  });
  if (result.count !== 1) throw new LotConcurrencyError(lotId);
  return tx.itemLot.findUniqueOrThrow({ where: { id: lotId } });
}
